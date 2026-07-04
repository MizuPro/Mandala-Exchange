package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"
)

type APIClient struct {
	BaseURL    string
	Token      string
	HTTPClient *http.Client
}

type APIError struct {
	Status        int
	Code          string
	Message       string
	Retryable     bool
	CorrelationID string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("%s (status=%d correlation_id=%s): %s", e.Code, e.Status, e.CorrelationID, e.Message)
}

func NewAPIClient(baseURL, token string) *APIClient {
	return &APIClient{
		BaseURL: baseURL,
		Token:   token,
		HTTPClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// DoRequest performs an HTTP request with automatic 3x retry and exponential backoff
func (c *APIClient) DoRequest(ctx context.Context, method, path string, payload interface{}, headers map[string]string, out interface{}) error {
	var bodyBytes []byte
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("failed to marshal payload: %w", err)
		}
		bodyBytes = b
	}

	var lastErr error
	backoff := 100 * time.Millisecond

	for attempt := 1; attempt <= 3; attempt++ {
		// Respect context timeout/cancellation
		if err := ctx.Err(); err != nil {
			return err
		}

		var body io.Reader
		if bodyBytes != nil {
			body = bytes.NewReader(bodyBytes)
		}

		req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, body)
		if err != nil {
			return fmt.Errorf("failed to create request: %w", err) // Non-retryable
		}

		// Set headers
		if c.Token != "" {
			req.Header.Set("x-service-token", c.Token)
		}
		req.Header.Set("x-correlation-id", uuid.NewString())
		if bodyBytes != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}

		resp, err := c.HTTPClient.Do(req)
		if err != nil {
			lastErr = err
			// Retry on network errors
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
				backoff *= 2
				continue
			}
		}

		defer resp.Body.Close()

		if resp.StatusCode >= 400 {
			var envelope struct {
				Error struct {
					Code          string `json:"code"`
					Message       string `json:"message"`
					Retryable     bool   `json:"retryable"`
					CorrelationID string `json:"correlation_id"`
				} `json:"error"`
			}

			// Read response body safely with limit
			bodyData, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			if readErr != nil {
				lastErr = &APIError{Status: resp.StatusCode, Code: "BODY_READ_ERROR", Message: readErr.Error()}
			} else if jsonErr := json.Unmarshal(bodyData, &envelope); jsonErr != nil {
				lastErr = &APIError{Status: resp.StatusCode, Code: "UNKNOWN_ERROR", Message: string(bodyData)}
			} else {
				lastErr = &APIError{
					Status:        resp.StatusCode,
					Code:          envelope.Error.Code,
					Message:       envelope.Error.Message,
					Retryable:     envelope.Error.Retryable,
					CorrelationID: envelope.Error.CorrelationID,
				}
			}

			// Determine if error is retryable
			isRetryable := resp.StatusCode >= 500 || (envelope.Error.Retryable)
			if !isRetryable {
				return lastErr // Return immediately for non-retryable 4xx
			}

			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
				backoff *= 2
				continue
			}
		}

		// Success status code
		if out != nil {
			if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
				return fmt.Errorf("failed to decode response: %w", err)
			}
		}
		return nil
	}

	return fmt.Errorf("request failed after 3 attempts. Last error: %w", lastErr)
}

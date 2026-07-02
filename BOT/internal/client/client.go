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
	"github.com/sethvargo/go-retry"
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

func (c *APIClient) DoRequest(ctx context.Context, method, path string, payload interface{}, idempotencyKey string, out interface{}) error {
	var bodyBytes []byte
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		bodyBytes = b
	}

	backoff := retry.NewExponential(100 * time.Millisecond)
	backoff = retry.WithMaxRetries(3, backoff)

	return retry.Do(ctx, backoff, func(ctx context.Context) error {
		var body io.Reader
		if bodyBytes != nil {
			body = bytes.NewReader(bodyBytes)
		}

		req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, body)
		if err != nil {
			return err // Bad request creation is not retryable
		}

		if c.Token != "" {
			req.Header.Set("x-service-token", c.Token)
		}
		if idempotencyKey != "" {
			req.Header.Set("Idempotency-Key", idempotencyKey)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("x-correlation-id", uuid.NewString())

		resp, err := c.HTTPClient.Do(req)
		if err != nil {
			// Network error, timeout, context cancelled, etc.
			// Retryable network failure.
			return retry.RetryableError(err)
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
			if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&envelope); err != nil {
				apiErr := &APIError{Status: resp.StatusCode, Code: "DEPENDENCY_ERROR", Message: http.StatusText(resp.StatusCode)}
				if resp.StatusCode >= 500 {
					return retry.RetryableError(apiErr)
				}
				return apiErr
			}
			apiErr := &APIError{Status: resp.StatusCode, Code: envelope.Error.Code, Message: envelope.Error.Message, Retryable: envelope.Error.Retryable, CorrelationID: envelope.Error.CorrelationID}
			
			if resp.StatusCode >= 500 || envelope.Error.Retryable {
				return retry.RetryableError(apiErr)
			}
			return apiErr
		}

		if out != nil {
			if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
				return err
			}
		}

		return nil
	})
}

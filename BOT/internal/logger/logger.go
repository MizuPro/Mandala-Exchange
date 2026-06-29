package logger

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type LogLevel string

const (
	LevelInfo  LogLevel = "INFO"
	LevelWarn  LogLevel = "WARN"
	LevelError LogLevel = "ERROR"
)

type LogEntry struct {
	Timestamp time.Time              `json:"timestamp"`
	Level     LogLevel               `json:"level"`
	Message   string                 `json:"message"`
	Fields    map[string]interface{} `json:"fields,omitempty"`
}

func redact(val string) string {
	if len(val) > 8 {
		return val[:4] + "****" + val[len(val)-4:]
	}
	return "****"
}

func RedactSecretFields(fields map[string]interface{}) map[string]interface{} {
	redacted := make(map[string]interface{})
	for k, v := range fields {
		keyLower := strings.ToLower(k)
		if strings.Contains(keyLower, "token") || strings.Contains(keyLower, "secret") || strings.Contains(keyLower, "password") || strings.Contains(keyLower, "jwt") {
			if s, ok := v.(string); ok {
				redacted[k] = redact(s)
			} else {
				redacted[k] = "****"
			}
		} else {
			redacted[k] = v
		}
	}
	return redacted
}

func Log(level LogLevel, msg string, fields map[string]interface{}) {
	entry := LogEntry{
		Timestamp: time.Now(),
		Level:     level,
		Message:   msg,
		Fields:    RedactSecretFields(fields),
	}

	b, _ := json.Marshal(entry)
	fmt.Println(string(b))
}

func Info(msg string, fields map[string]interface{})  { Log(LevelInfo, msg, fields) }
func Warn(msg string, fields map[string]interface{})  { Log(LevelWarn, msg, fields) }
func Error(msg string, fields map[string]interface{}) { Log(LevelError, msg, fields) }

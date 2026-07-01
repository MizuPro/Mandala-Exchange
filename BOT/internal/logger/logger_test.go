package logger

import (
	"testing"
)

// TestRedactSecretFields verifies that fields containing "token", "secret",
// "password", or "jwt" (case-insensitive) are redacted in log output.
func TestRedactSecretFields_TokenRedacted(t *testing.T) {
	fields := map[string]interface{}{
		"user_token": "eyJhbGciOiJSUzI1NiJ9.verylongpayload.signature",
		"account_id": "acc-1234",
	}
	redacted := RedactSecretFields(fields)

	if redacted["user_token"] == fields["user_token"] {
		t.Error("user_token should be redacted")
	}
	if redacted["account_id"] != "acc-1234" {
		t.Errorf("account_id should not be redacted, got %v", redacted["account_id"])
	}
}

func TestRedactSecretFields_SecretRedacted(t *testing.T) {
	fields := map[string]interface{}{
		"db_secret": "super-secret-db-password",
		"env":       "development",
	}
	redacted := RedactSecretFields(fields)

	if redacted["db_secret"] == "super-secret-db-password" {
		t.Error("db_secret should be redacted")
	}
	if redacted["env"] != "development" {
		t.Errorf("env should not be redacted, got %v", redacted["env"])
	}
}

func TestRedactSecretFields_PasswordRedacted(t *testing.T) {
	fields := map[string]interface{}{
		"password":   "hunter2",
		"user_email": "bot@exchange.local",
	}
	redacted := RedactSecretFields(fields)

	if redacted["password"] == "hunter2" {
		t.Error("password should be redacted")
	}
	if redacted["user_email"] != "bot@exchange.local" {
		t.Errorf("user_email should not be redacted, got %v", redacted["user_email"])
	}
}

func TestRedactSecretFields_JWTRedacted(t *testing.T) {
	fields := map[string]interface{}{
		"jwt_value": "eyJhbGci.payload.sig",
		"symbol":    "BBCA",
	}
	redacted := RedactSecretFields(fields)

	if redacted["jwt_value"] == "eyJhbGci.payload.sig" {
		t.Error("jwt_value should be redacted")
	}
	if redacted["symbol"] != "BBCA" {
		t.Errorf("symbol should not be redacted, got %v", redacted["symbol"])
	}
}

func TestRedactSecretFields_CaseInsensitive(t *testing.T) {
	fields := map[string]interface{}{
		"TOKEN":       "uppercase-token-value",
		"Secret_Key":  "mixed-case-secret",
		"JWT_HEADER":  "jwt-in-caps",
		"PASSWORD_DB": "pass-all-caps",
	}
	redacted := RedactSecretFields(fields)

	sensitiveKeys := []string{"TOKEN", "Secret_Key", "JWT_HEADER", "PASSWORD_DB"}
	for _, k := range sensitiveKeys {
		if redacted[k] == fields[k] {
			t.Errorf("key %q should be redacted (case-insensitive match)", k)
		}
	}
}

func TestRedactSecretFields_NonStringValuesRedacted(t *testing.T) {
	// Non-string sensitive fields should be replaced with "****"
	fields := map[string]interface{}{
		"token_count": 42, // non-string token field
		"bot_count":   10,
	}
	redacted := RedactSecretFields(fields)

	if redacted["token_count"] != "****" {
		t.Errorf("non-string token field should be redacted to '****', got %v", redacted["token_count"])
	}
	if redacted["bot_count"] != 10 {
		t.Errorf("non-sensitive field should not be redacted, got %v", redacted["bot_count"])
	}
}

func TestRedactSecretFields_EmptyFields(t *testing.T) {
	// Empty fields map should return empty map without panic
	redacted := RedactSecretFields(map[string]interface{}{})
	if len(redacted) != 0 {
		t.Errorf("expected empty map, got %d entries", len(redacted))
	}
}

func TestRedactSecretFields_NilFields(t *testing.T) {
	// Nil fields should not panic
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("RedactSecretFields panicked on nil input: %v", r)
		}
	}()
	redacted := RedactSecretFields(nil)
	if redacted == nil {
		t.Error("expected non-nil map returned for nil input")
	}
}

// TestRedact verifies the redact helper preserves first/last 4 chars for long values.
func TestRedact_LongValue(t *testing.T) {
	result := redact("eyJhbGciOiJSUzI1NiJ9longpayload")
	if len(result) == 0 {
		t.Error("expected non-empty redacted value")
	}
	// Should have first 4 + **** + last 4
	if result[4:8] != "****" {
		t.Errorf("expected middle to be ****, got: %s", result)
	}
}

func TestRedact_ShortValue(t *testing.T) {
	result := redact("abc") // <= 8 chars
	if result != "****" {
		t.Errorf("expected short value to be completely redacted as ****, got: %s", result)
	}
}

// TestLogDoesNotPanic verifies that Log/Info/Warn/Error don't panic on normal usage.
func TestLogDoesNotPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("Log panicked: %v", r)
		}
	}()

	Info("test info message", map[string]interface{}{"key": "value", "token": "secret123456789"})
	Warn("test warn message", nil)
	Error("test error message", map[string]interface{}{"error": "something failed"})
}

package auth

import (
	"context"
	"net/http"
	"strings"

	"mandala-exchange/mats/internal/config"
)

type contextKey string

const identityContextKey contextKey = "identity"

type Identity struct {
	Name   string
	Scopes map[string]struct{}
}

type Authenticator struct {
	tokens map[string]Identity
}

func New(tokens []config.ServiceToken) *Authenticator {
	auth := &Authenticator{tokens: make(map[string]Identity, len(tokens))}
	for _, token := range tokens {
		scopes := make(map[string]struct{}, len(token.Scopes))
		for _, scope := range token.Scopes {
			scopes[scope] = struct{}{}
		}
		auth.tokens[token.Token] = Identity{Name: token.Name, Scopes: scopes}
	}
	return auth
}

func (a *Authenticator) Middleware(requiredScope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := strings.TrimSpace(r.Header.Get("x-service-token"))
			if token == "" {
				token = strings.TrimSpace(r.URL.Query().Get("access_token"))
			}
			identity, ok := a.tokens[token]
			if !ok || token == "" {
				writeAuthError(w, http.StatusUnauthorized, "missing_or_invalid_service_token")
				return
			}
			if !identity.HasScope(requiredScope) {
				writeAuthError(w, http.StatusForbidden, "insufficient_scope")
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityContextKey, identity)))
		})
	}
}

func IdentityFromContext(ctx context.Context) (Identity, bool) {
	identity, ok := ctx.Value(identityContextKey).(Identity)
	return identity, ok
}

func (i Identity) HasScope(scope string) bool {
	if scope == "" {
		return true
	}
	if _, ok := i.Scopes["admin:*"]; ok {
		return true
	}
	if _, ok := i.Scopes[scope]; ok {
		return true
	}
	prefix, _, found := strings.Cut(scope, ":")
	if found {
		_, ok := i.Scopes[prefix+":*"]
		return ok
	}
	return false
}

func writeAuthError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"error":"` + code + `"}`))
}

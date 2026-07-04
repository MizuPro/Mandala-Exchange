package logger

import (
	"context"
	"log/slog"
	"os"
)

var defaultLogger *slog.Logger

func Init() {
	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelDebug, // Debug level untuk Fase 3 testing
	})
	defaultLogger = slog.New(handler)
	slog.SetDefault(defaultLogger)
}

func Info(msg string, args ...any) {
	if defaultLogger == nil {
		Init()
	}
	defaultLogger.Info(msg, args...)
}

func Warn(msg string, args ...any) {
	if defaultLogger == nil {
		Init()
	}
	defaultLogger.Warn(msg, args...)
}

func Error(msg string, args ...any) {
	if defaultLogger == nil {
		Init()
	}
	defaultLogger.Error(msg, args...)
}

func Debug(msg string, args ...any) {
	if defaultLogger == nil {
		Init()
	}
	defaultLogger.Debug(msg, args...)
}

func With(args ...any) *slog.Logger {
	if defaultLogger == nil {
		Init()
	}
	return defaultLogger.With(args...)
}

// LogCtx error with context and details
func ErrorCtx(ctx context.Context, msg string, err error, args ...any) {
	if defaultLogger == nil {
		Init()
	}
	allArgs := append([]any{"error", err.Error()}, args...)
	defaultLogger.ErrorContext(ctx, msg, allArgs...)
}

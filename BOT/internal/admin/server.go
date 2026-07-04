package admin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/Mandala-Exchange/bot-v2/internal/client/bei"
	"github.com/Mandala-Exchange/bot-v2/internal/client/sekuritas"
	"github.com/Mandala-Exchange/bot-v2/internal/executor"
	"github.com/Mandala-Exchange/bot-v2/internal/logger"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type Server struct {
	port            int
	beiClient       *bei.Client
	sekuritasClient *sekuritas.Client
	exec            *executor.Executor
	stopFunc        context.CancelFunc

	httpServer *http.Server
	mu         sync.Mutex
}

func NewServer(port int, beiClient *bei.Client, sekuritasClient *sekuritas.Client, exec *executor.Executor, stopFunc context.CancelFunc) *Server {
	return &Server{
		port:            port,
		beiClient:       beiClient,
		sekuritasClient: sekuritasClient,
		exec:            exec,
		stopFunc:        stopFunc,
	}
}

func (s *Server) Start() {
	s.httpServer = &http.Server{
		Addr:    fmt.Sprintf(":%d", s.port),
		Handler: s.Handler(),
	}

	go func() {
		logger.Info("Admin HTTP Server starting", "port", s.port)
		if err := s.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("Admin HTTP Server failed", "error", err.Error())
		}
	}()
}

func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Get("/health", s.handleHealth)
	r.Post("/admin/pause", s.handlePause)
	r.Post("/admin/resume", s.handleResume)
	r.Post("/admin/stop", s.handleStop)
	return r
}

func (s *Server) Stop(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.httpServer != nil {
		logger.Info("Admin HTTP Server shutting down...")
		return s.httpServer.Shutdown(ctx)
	}
	return nil
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	// Status details
	sessionStale := s.beiClient.IsSessionStale()
	rulesStale := s.beiClient.IsRulesStale()
	feesStale := s.beiClient.IsFeesStale()
	sekuritasConnected := s.sekuritasClient.StreamConnected()
	executorPaused := s.exec.IsPaused()

	status := "healthy"
	if sessionStale || rulesStale || feesStale {
		status = "degraded"
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    status,
		"timestamp": time.Now().Format(time.RFC3339),
		"downstream": map[string]interface{}{
			"bei_session_stale":   sessionStale,
			"bei_rules_stale":     rulesStale,
			"bei_fees_stale":      feesStale,
			"sekuritas_connected": sekuritasConnected,
			"executor_paused":     executorPaused,
		},
	})
}

func (s *Server) handlePause(w http.ResponseWriter, r *http.Request) {
	s.exec.SetPaused(true)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "paused"})
}

func (s *Server) handleResume(w http.ResponseWriter, r *http.Request) {
	s.exec.SetPaused(false)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "running"})
}

func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "shutdown_initiated"})

	// Trigger stop signal in background so server can respond first
	go func() {
		time.Sleep(1 * time.Second)
		logger.Warn("Shutdown initiated via Admin API /admin/stop")
		s.stopFunc()
	}()
}

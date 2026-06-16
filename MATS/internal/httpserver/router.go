package httpserver

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"mandala-exchange/mats/internal/api"
	"mandala-exchange/mats/internal/auth"
	"mandala-exchange/mats/internal/marketdata"
)

func NewRouter(handler *api.Handler, authenticator *auth.Authenticator, hub *marketdata.Hub) http.Handler {
	router := chi.NewRouter()
	router.Use(middleware.RequestID)
	router.Use(middleware.RealIP)
	router.Use(middleware.Recoverer)

	router.Get("/health", handler.Health)

	router.Route("/v1", func(r chi.Router) {
		r.Group(func(r chi.Router) {
			r.Use(authenticator.Middleware("order:write"))
			r.Post("/orders", handler.PlaceOrder)
			r.Patch("/orders/{orderId}", handler.AmendOrder)
			r.Post("/orders/{orderId}/cancel", handler.CancelOrder)
		})

		r.Group(func(r chi.Router) {
			r.Use(authenticator.Middleware("order:read"))
			r.Get("/orders/{orderId}", handler.GetOrder)
		})

		r.Group(func(r chi.Router) {
			r.Use(authenticator.Middleware("sync:write"))
			r.Post("/admin/sync/bei", handler.SyncBEI)
		})

		r.Group(func(r chi.Router) {
			r.Use(authenticator.Middleware("admin:read"))
			r.Get("/admin/books/{symbol}", handler.BookSnapshot)
			r.Get("/admin/delivery-events", handler.DeliveryEvents)
		})

		r.Group(func(r chi.Router) {
			r.Use(authenticator.Middleware("admin:*"))
			r.Post("/admin/session/status", handler.SetSessionStatus)
			r.Post("/admin/session/halt", handler.HaltMarket)
			r.Post("/admin/session/resume", handler.ResumeMarket)
			r.Post("/admin/session/random-closing", handler.StartRandomClosing)
			r.Post("/admin/symbols/{symbol}/suspend", handler.SuspendSymbol)
			r.Post("/admin/symbols/{symbol}/resume", handler.ResumeSymbol)
			r.Post("/admin/orders/expire", handler.ExpireOpenOrders)
			r.Get("/admin/auction/{symbol}/indicative", handler.AuctionIndicative)
			r.Post("/admin/auction/{symbol}/uncross", handler.UncrossAuction)
		})

		r.Group(func(r chi.Router) {
			r.Use(authenticator.Middleware("market:read"))
			r.Get("/market-data/ws", hub.ServeHTTP)
		})
	})

	return router
}

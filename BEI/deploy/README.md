# Deployment Notes

BEI Service can run locally or behind Cloudflare Tunnel.

1. Run PostgreSQL with `docker compose up -d`.
2. Run migrations and seed data with `npm run db:migrate && npm run db:seed`.
3. Start the service with `npm run start` after `npm run build`.
4. Put the service behind Cloudflare Tunnel using `cloudflare-tunnel.example.yml`.
5. Keep `x-service-token` enabled even when Cloudflare Access is used, because platform default domains or internal networks may still reach the process.

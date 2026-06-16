# MATS Deployment Notes

## Cloudflare Tunnel

1. Copy `cloudflare-tunnel.example.yml` to your Cloudflare host config.
2. Replace `mats.internal.example.com` with the internal API hostname.
3. Protect the hostname with Cloudflare Access.
4. Keep `MATS_SERVICE_TOKENS`, `BEI_SERVICE_TOKEN`, and `SEKURITAS_SERVICE_TOKEN` out of source control.

Recommended local service binding:

```bash
MATS_HTTP_ADDR=127.0.0.1:8082
```

Public player traffic should only use `GET /v1/market-data/ws`. Order APIs remain service-to-service through Sekuritas.

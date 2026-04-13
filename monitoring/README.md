**VSClone Monitoring**

- Grafana dashboard: monitoring/grafana/vsclone-dashboard.json — import in Grafana (Dashboard -> Manage -> Import JSON).
- Prometheus alert rules: monitoring/prometheus/vsclone-alerts.yaml — add to Prometheus `rule_files` and configure Alertmanager.

Notes:
- Tune thresholds (latency, in-flight, memory) to your environment before enabling page-level alerts.
- The main process exposes `/metrics` on localhost:9464 by default via the `prom-client` registry in the Electron main process module `vscloneMetrics.ts`.
- To enable scraping in production, ensure your Prometheus can reach the host and port or forward metrics to a pushgateway.

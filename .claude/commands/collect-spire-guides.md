Check the current OpenClaw guide collection status by fetching GET /api/agent/status (server runs at http://localhost:7788). Then trigger a new collection by sending POST /api/agent/collect with body {"keyword":"杀戮尖塔"}.

Poll GET /api/agent/status every 3 seconds until `running` is false, printing each new log line as it appears. When done, print a summary table showing how many guides were collected per source (tieba / xiaohongshu) and the total count in TiDB.

Finally confirm that the RAG system is ready: the guides are now searchable from the OpenClaw chat — users can ask questions about 杀戮尖塔 and Agnes will automatically retrieve relevant guides from TiDB to answer.

# 收集《杀戮尖塔》攻略到知识库

从百度贴吧和小红书抓取《杀戮尖塔》攻略，保存到 TiDB，RAG 自动就绪。

## 执行步骤

1. 调用 `GET /api/agent/status` 查看当前知识库状态
2. 调用 `POST /api/agent/collect` 触发爬取（keyword: 杀戮尖塔）
3. 每 3 秒轮询 `GET /api/agent/status`，打印新增日志，直到 running=false
4. 展示收集结果：各来源条数 / 新增 / 总量
5. 提示用户：RAG 已就绪，可直接在聊天中提问攻略相关问题

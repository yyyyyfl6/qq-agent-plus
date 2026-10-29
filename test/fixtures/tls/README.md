# 测试专用 TLS 证书

`localhost-cert.pem` / `localhost-key.pem` 只用于 `test/safe-fetch.test.mjs` 的本地 HTTP/2 测试
（SAN：`localhost`、`pinned.test`、`127.0.0.1`、`::1`）。私钥没有保密价值，**不要**在部署或
生产环境中使用；测试进程只通过 `tls.setDefaultCACertificates` 临时信任这张证书。

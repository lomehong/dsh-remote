# Changelog

本插件所有显著变更记录于此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
发布纪律：**tag = release**（每个发布对应一个 GitHub 标签，自更新以标签 tarball 为源）。

## [0.1.2] — 2026-08-29

### 新增

- 设置页自更新：「软件更新」分区支持检查更新（GitHub 标签 semver 比较）与一键更新；
  后台单飞执行，进度经 check 端点回报（`/dsh-remote/api/update/check`、`/dsh-remote/api/update/apply`）
- 自更新安全设计：符号链接安装（开发模式）拒绝就地覆盖；仅替换 `lib/**` 与 `package.json`
  （不动 cordis.patch.yml）；下载/解压/校验在 `.update-staging/` 完成后才换装，
  换装失败自动回滚（保留 `lib.bak-<ts>` 备份）；写 `.update-pending` 标记，重启 DSH 后生效
- 零新增运行时依赖：HTTPS 用 node:https（重定向/超时/体积上限），tar 用内置 512 字节头解析
- `scripts/boot-smoke.sh`：隔离 DSH_HOME + file:// patch 的启动冒烟（无 dsh CLI 时优雅跳过），并接入 CI
- 本 CHANGELOG

## [0.1.1] — 2026-08-29

### 新增

- 网关支持 `GET /__remote/pair?token=` 种浏览器 cookie（桌面壳对接）

### 测试

- pair?token= 用例补断言 touch 生效（lastSeenAt 前进）等测试加固

## [0.1.0] — 2026-08-28

### 新增

- 首个版本：配对认证网关（HTTP+WS 反代、设备管理、限速、设置页、CI）

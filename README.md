# docker-forward

一个**临时的 Docker Hub 转发镜像站**，给访问不了 Docker Hub 的服务器（比如国内的云服务器）拉镜像用。

在一台能访问 Docker Hub 的服务器上运行它，再把国内服务器的 Docker 指向它作为镜像加速地址，就能正常 `docker pull`。用完按 `Ctrl+C` 关掉即可。

- **单个文件、零依赖**：只需要 Node.js 18.3 或更高版本（推荐 20+）
- **不存盘**：清单和镜像层都是现用现取，直接从 Docker Hub 转发过去
- **自带访问控制**：只服务指定的来源 IP，也可以只允许指定的镜像仓库
- **只支持拉取**：不能用来推送镜像
- **HTTPS 可选**：不提供证书时使用 HTTP，免去证书配置

## 工作原理

```
国内服务器 Docker ──HTTP(S)──▶ 海外服务器 docker-forward ──HTTPS──▶ Docker Hub
```

国内服务器只连接海外服务器的 IP，不会出现 Docker Hub 的域名，因此不受国内网络对 Docker Hub 的封锁影响。docker-forward 收到请求后，替国内服务器向 Docker Hub 申请匿名拉取令牌、获取镜像清单和镜像层，再把内容原样转发回去。Docker 会用 sha256 摘要校验收到的每一层。

## 快速开始

下面用 `1.2.3.4` 代表海外服务器的公网 IP，`5.6.7.8` 代表国内服务器的公网 IP，请换成你自己的。

### 1. 在海外服务器上启动

```bash
curl -fsSLO https://raw.githubusercontent.com/UF4007/docker-forward/main/docker-forward.mjs
node docker-forward.mjs --allow-ip 5.6.7.8
```

没有安装 Node.js 的话，可以借 Docker 运行（海外服务器能正常拉镜像）：

```bash
docker run --rm -p 5000:5000 -v "$PWD":/app node:22-alpine node /app/docker-forward.mjs --allow-ip 5.6.7.8
```

然后在防火墙或云服务商的安全组里**放行 5000 端口的入站连接**。

### 2. 在国内服务器上配置 Docker

编辑 `/etc/docker/daemon.json`（没有就新建），把镜像站加到 `registry-mirrors` 的**最前面**，并加上 `insecure-registries` 允许 Docker 用 HTTP 访问它：

```json
{
  "registry-mirrors": ["http://1.2.3.4:5000"],
  "insecure-registries": ["1.2.3.4:5000"]
}
```

如果原来已经有别的加速地址（比如阿里云的），保留它们，写在后面即可。然后重启 Docker：

```bash
sudo systemctl restart docker
```

### 3. 正常拉镜像

```bash
sudo docker pull node:22-alpine
sudo docker compose up -d      # docker compose 也一样
```

拉取过程中，海外服务器的终端会逐条打印请求日志。

### 4. 用完关闭

- 海外服务器：按 `Ctrl+C` 停止。
- 国内服务器：可以把 `daemon.json` 改回原样再重启 Docker；不改也行，镜像站关掉后 Docker 会自动尝试下一个加速地址或官方地址。

## 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--allow-ip` | （必填） | 允许访问的客户端 IP，多个用逗号分隔。填 `any` 表示谁都能用，不建议 |
| `--allow-repo` | 空（不限制） | 只允许拉取这些仓库，多个用逗号分隔。官方镜像要写成 `library/名字`，例如 `library/node` |
| `--port` | `5000` | 监听端口 |
| `--cert` / `--key` | 无 | 证书和私钥文件。同时提供时使用 HTTPS，否则使用 HTTP |

例如只允许拉 NapCat 和 Node.js 的镜像：

```bash
node docker-forward.mjs --allow-ip 5.6.7.8 --allow-repo mlikiowa/napcat-docker,library/node
```

## 启用 HTTPS（可选）

HTTP 模式下，两台服务器之间的流量没有加密，镜像内容理论上可能在途中被篡改。临时拉一次通常问题不大；如果在意，可以用自签名证书启用 HTTPS。

在海外服务器上生成证书（有效期 7 天，把 IP 换成海外服务器的），并带上证书启动：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 7 \
  -keyout mirror.key -out mirror.crt \
  -subj "/CN=docker-forward" -addext "subjectAltName=IP:1.2.3.4"
node docker-forward.mjs --allow-ip 5.6.7.8 --cert mirror.crt --key mirror.key
```

在国内服务器上，让 Docker 信任这张证书，并把镜像地址改成 `https`：

```bash
sudo mkdir -p /etc/docker/certs.d/1.2.3.4:5000
sudo scp root@1.2.3.4:~/mirror.crt /etc/docker/certs.d/1.2.3.4:5000/ca.crt
```

```json
{
  "registry-mirrors": ["https://1.2.3.4:5000"]
}
```

然后 `sudo systemctl restart docker`。如果拉取时报 `x509: certificate signed by unknown authority`，说明证书没有生效，可以先退回 HTTP 模式。

## 排查问题

- **国内服务器拉不动，海外服务器的终端没有任何日志**：请求没有到达。检查安全组或防火墙是否放行了 5000 端口，以及 `daemon.json` 里的地址和端口是否正确、Docker 是否已经重启。可以用 `sudo docker info | grep -A3 -i 'registry mirrors'` 确认配置已生效。
- **日志里出现 `403`**：来源 IP 不在 `--allow-ip` 里，或者仓库不在 `--allow-repo` 里。日志会显示脚本实际看到的来源 IP，把它填进 `--allow-ip` 即可。
- **日志里出现 `502`**：海外服务器访问 Docker Hub 出错，终端里会打印具体原因。
- **Docker 仍然去访问阿里云等其他地址**：把本镜像站放在 `registry-mirrors` 的第一位。

## 限制

- **只能代理 Docker Hub**：Docker 的 `registry-mirrors` 只对 Docker Hub 上的镜像生效，`ghcr.io`、`quay.io` 等其他仓库的镜像不会经过它。
- **不缓存**：每次拉取都从 Docker Hub 重新获取，流量全部经过海外服务器。
- **匿名拉取**：使用 Docker Hub 的匿名令牌，只能拉公开镜像，并受 Docker Hub 匿名拉取的频率限制。
- 只支持 `GET` / `HEAD` 拉取请求，不支持推送。

## 验证情况

已在开发环境中验证：通过它拉取 `node:22-alpine` 的多架构清单、amd64 清单和镜像层，以及 `mlikiowa/napcat-docker:latest` 的清单，在 HTTP 和 HTTPS 两种模式下，内容都与 Docker 校验用的 sha256 摘要一致；不在白名单内的仓库、非法路径和推送请求都会被拒绝。

尚未在"国内服务器 + 真实 Docker 守护进程"的环境里完整走过一遍，遇到问题欢迎提 issue。

# 尝试强制移除名为 gomoku-server 的旧容器，如果不存在则忽略错误
try {
    docker rm -f gomoku-server
}
catch {}

docker run --rm -p 3000:3000 -v ./data:/app/data -v ./submissions:/app/submissions -v ./logs:/app/logs --name gomoku-server gomoku-platform
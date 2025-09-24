docker rm -f gomoku-server

docker run --rm -p 3000:3000 -v ./data:/app/data -v ./submissions:/app/submissions -v ./logs:/app/logs --name gomoku-server gomoku-platform
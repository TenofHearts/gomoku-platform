# --- 构建阶段 (Builder) ---
# 使用完整的 Node.js 镜像，其中包含所有构建工具
FROM node:18-bullseye AS builder

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json (如果存在)
# 这利用了 Docker 的缓存机制
COPY package*.json ./

# 安装所有依赖，包括 devDependencies (如果将来有的话)
# 这对于运行测试或构建步骤是必要的
RUN npm install

# 复制项目中的所有文件到构建阶段
COPY . .

# 如果您有编译步骤 (例如 TypeScript -> JavaScript)，可以在这里添加
# RUN npm run build


# --- 生产阶段 (Final) ---
# 使用一个轻量级的、更安全的 slim 镜像作为最终的基础
FROM node:18-bullseye-slim

# 再次设置工作目录
WORKDIR /app

# 从构建阶段 (builder) 复制 package.json 和生产环境所需的 node_modules
# --production 标志确保只复制生产依赖
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./

# 从构建阶段复制应用程序的源代码
COPY --from=builder /app/ .

# 声明容器在运行时监听的端口
EXPOSE 3000

# 定义容器启动时执行的命令
CMD ["npm", "start"]
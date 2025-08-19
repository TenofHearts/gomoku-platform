# 五子棋对弈平台开发计划（教学版）

## 项目概述

构建一个轻量级五子棋AI对弈平台，专为教学环境设计，支持不超过200名学生上传AI代码、自动打擂台比赛、生成排行榜。重点是简单、易部署、易维护。

## 系统架构

### 极简架构
```
Frontend (HTML + Vue 3 CDN + Bootstrap)
    ↓ HTTP
Backend (Node.js + Express 单体服务)
    ↓
JSON Files (students.json, rankings.json, submissions.json)
    ↓
Python AI Engine (基于现有gomoku代码)
```

## 功能规划

### 前端功能 (HTML + Vue 3 + Bootstrap)

#### 1. 学生登录页面 (login.html)
- **简单认证**
  - 学号 + 密码输入框
  - 基于 students.json 验证
  - 登录成功后跳转到上传页面

#### 2. AI代码上传页面 (upload.html)
- **文件上传界面**
  - 单个 Python 文件上传 (.py, 限制50KB)
  - 简单的文件预览 (textarea 显示代码内容)
  - 上传前的基本验证 (检查是否包含 Agent 类)
  - 每个学生只能提保留一份代码，新提交覆盖旧代码

#### 3. 排行榜页面 (rankings.html)
- **静态排行榜显示**
  - Top 10 AI智能体展示（显示学号）
  - 胜场数、败场数、胜率统计
  - 上传时间和当前排名
  - 手动刷新页面查看最新排名

#### 4. 个人记录页面 (results.html)
- **比赛历史记录**
  - 显示该学生AI的所有比赛记录
  - 对战对手、比赛结果、时间
  - 简单的统计信息

### 后端功能 (Node.js + Express)

#### 1. 学生认证系统
- **简单认证服务**
  - 基于 students.json 文件的学号密码验证, 以及密码修改功能
  - 简单的 session 或 cookie 认证
  - 无需复杂的 JWT

#### 2. AI代码管理
- **文件上传处理**
  - 使用 multer 处理文件上传
  - 基本的文件验证（大小、类型、内容检查）
  - 将代码保存到 submissions/ 目录
  - 更新 submissions.json 记录

#### 3. 打擂台系统（核心功能）
- **简化的挑战机制**
  - 新AI自动从第10名开始挑战
  - 每场比赛并发进行10局，胜者为胜局多的一方
  - 比赛串行执行，避免并发复杂性
  - 胜利后自动挑战更高排名
  - 更新 rankings.json 文件

#### 4. Python AI执行器
- **调用现有 gomoku.py**
  - 使用 child_process 执行 Python 脚本
  - 命令格式：`python gomoku.py --agent1 path1.py --agent2 path2.py --games 10`
  - 解析比赛结果 JSON 输出
  - 30秒超时控制

### 数据存储设计（JSON文件）

#### students.json - 学生信息
```json
{
  "2021001": {
    "password": "hashedPassword",
    "name": "张三",
    "created_at": "2025-01-01"
  }
}
```

#### rankings.json - 排行榜
```json
{
  "rankings": [
    {
      "rank": 1,
      "student_id": "2021001",
      "wins": 45,
      "losses": 5,
      "win_rate": 0.9,
      "last_updated": "2025-01-15"
    }
  ]
}
```

#### submissions.json - 提交记录
```json
{
  "2021001": {
    "filename": "agent_2021001.py",
    "upload_time": "2025-01-15T10:30:00Z",
    "file_path": "./submissions/agent_2021001.py",
    "status": "active"
  }
}
```

#### matches.json - 比赛记录
```json
{
  "matches": [
    {
      "id": "match_001",
      "challenger": "2021001",
      "defender": "2021002",
      "winner": "2021001",
      "games_played": 10,
      "challenger_wins": 6,
      "defender_wins": 4,
      "timestamp": "2025-01-15T11:00:00Z"
    }
  ]
}
```

## 技术实现细节

### 前端技术栈（极简）
- **HTML5** - 基础页面结构
- **Vue 3 (CDN)** - 轻量级前端框架，无需构建工具
- **Bootstrap 5 (CDN)** - CSS框架，快速美化
- **原生 JavaScript** - 处理表单和Ajax请求
- **无需构建工具** - 直接在浏览器中运行

### 后端技术栈（单体服务）
- **Node.js** - 运行时环境
- **Express.js** - 极简Web框架
- **Multer** - 文件上传处理
- **fs/path** - 文件系统操作（读写JSON）
- **write-file-atomic** - 原子性文件写入，确保JSON文件写入安全
- **child_process** - 调用Python脚本
- **无需数据库** - JSON文件存储

### Python AI要求（标准化）
学生提交的Python文件必须：
```python
from agent import Agent

class Search(Agent):
    def __init__(self, player):
        super().__init__(player)
    
    def make_move(self, board):
        # 学生实现的AI逻辑
        return (row, col)
```

### 打擂台执行流程
1. **新AI上传** → 验证文件 → 保存到submissions/
2. **自动挑战** → 从第10名开始挑战
3. **比赛执行** → `python match.py --challenger new_ai.py --defender rank10.py --games 10`
4. **结果处理** → 解析JSON结果，更新排名
5. **继续挑战** → 如果胜利，挑战更高排名
6. **更新数据** → 写入rankings.json和matches.json

### JSON文件安全写入机制
为了确保多用户同时操作时数据的完整性，使用 `write-file-atomic` 库实现原子性文件操作：

```javascript
const writeFileAtomic = require('write-file-atomic');

// 安全更新排行榜
async function updateRankings(newRankings) {
    try {
        await writeFileAtomic('./data/rankings.json', 
            JSON.stringify(newRankings, null, 2), 
            'utf8'
        );
    } catch (error) {
        console.error('Failed to update rankings:', error);
        throw error;
    }
}

// 安全记录比赛结果
async function recordMatch(matchData) {
    const matches = await readJsonFile('./data/matches.json');
    matches.matches.push(matchData);
    await writeFileAtomic('./data/matches.json', 
        JSON.stringify(matches, null, 2), 
        'utf8'
    );
}
```

**原子性写入的优势：**
- **防止数据损坏** - 写入过程中断电或异常不会损坏原文件
- **并发安全** - 多个操作同时进行时不会产生冲突
- **事务性** - 要么完全成功，要么完全失败，不会产生中间状态
- **简单可靠** - 比文件锁机制更简单，适合教学环境

## 开发阶段

### 第一阶段：基础框架（1天）
1. **项目结构创建**
   ```
   gomoku-platform/
   ├── server.js              # Express服务器
   ├── public/                # 静态文件
   │   ├── login.html
   │   ├── upload.html
   │   ├── rankings.html
   │   └── results.html
   ├── data/                  # JSON数据文件
   │   ├── students.json
   │   ├── rankings.json
   │   ├── submissions.json
   │   └── matches.json
   ├── submissions/           # 学生提交的AI代码
   ├── gomoku/               # 五子棋引擎（复制现有代码）
   └── package.json
   ```
2. **Express基础路由设置**
3. **HTML页面框架搭建**

### 第二阶段：核心功能（2天）
1. **学生认证系统**
   - 登录验证API
   - Session管理
2. **文件上传功能**
   - AI代码上传和验证
   - 文件保存和记录更新
3. **基础前端页面**
   - 登录、上传、排行榜页面

### 第三阶段：打擂台系统（2天）
1. **Python脚本集成**
   - 修改gomoku.py支持批量比赛
   - 比赛结果JSON输出
2. **打擂台逻辑**
   - 自动挑战系统
   - 排名更新算法
3. **比赛记录管理**

### 第四阶段：完善和测试（1天）
1. **错误处理和日志**
2. **界面美化和优化**
3. **功能测试和调试**

**总计：6天完成**

## 安全考虑（教学级别）

### 代码安全（适度）
- **文件类型限制** - 仅允许 .py 文件上传
- **文件大小限制** - 最大 50KB
- **超时控制** - Python脚本执行30秒超时
- **基础代码检查** - 检查是否包含 Agent 类和 make_move 方法
- **禁止网络访问** - 教学环境下可信任，无需复杂沙箱

### 系统安全（简化）
- **输入验证** - 基本的表单验证
- **文件路径安全** - 防止路径遍历攻击
- **学号认证** - 简单的密码验证机制
- **原子性文件写入** - 使用 write-file-atomic 防止并发写入导致的数据损坏
- **无需防SQL注入** - 不使用数据库

## 部署方案

### 开发和生产统一（极简）
```bash
# 安装依赖
npm install express multer write-file-atomic

# 准备Python环境
pip install numpy

# 启动服务
node server.js
```

### 部署要求
- **Node.js 16+** 
- **Python 3.8+** 
- **单台服务器** - 无需集群或负载均衡
- **文件存储** - 本地文件系统即可
- **端口**: 3000 (可配置)

## 项目优势

### 教学适用性
1. **简单易懂** - 学生可以快速理解整个系统
2. **易于修改** - 教师可以轻松调整规则和参数
3. **快速部署** - 几分钟内完成部署
4. **资源占用低** - 适合教学服务器环境

### 维护便利性
1. **无数据库依赖** - 减少运维复杂度
2. **文件系统存储** - 数据易于备份和迁移
3. **日志文件** - 问题排查简单
4. **模块化设计** - 功能独立，易于扩展

### 技术学习价值
1. **全栈基础** - 涵盖前后端基本技术
2. **文件操作** - JSON数据处理
3. **进程调用** - Node.js与Python集成
4. **Web API设计** - RESTful接口实践

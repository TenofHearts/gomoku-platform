# 五子棋AI对战平台（教学版）

一个轻量级的五子棋AI对战平台，专为教学环境设计，支持学生上传AI代码、自动打擂台比赛、生成排行榜。

## 功能特性

- 🎯 **简单易用**：基于Web的界面，无需复杂配置
- 🏆 **自动打擂台**：新AI从第10名开始挑战，胜者晋升
- 📊 **实时排行榜**：显示所有AI的胜负记录和排名
- 📈 **比赛记录**：详细的个人比赛历史
- 🔒 **安全认证**：基于学号的简单认证系统

## 快速开始

### 1. 安装依赖

```bash
# 安装Node.js依赖
npm install

# 确保Python环境可用
pip install numpy
```

### 2. 启动服务

```bash
npm start
```

### 3. 访问平台

打开浏览器访问：http://localhost:3000

### 4. 使用测试账户

默认创建了5个测试账户：
- 学号：2021001-2021005
- 密码：123456

## AI代码要求

学生提交的Python文件必须包含以下结构：

```python
from agent import Agent

class Search(Agent):
    def __init__(self, player):
        super().__init__(player)
        # 初始化您的AI
    
    def make_move(self, board):
        """
        在棋盘上下一步棋
        
        参数:
            board: 15x15的二维numpy数组
                  0 = 空位
                  1 = 玩家1的棋子
                  2 = 玩家2的棋子
        
        返回:
            (row, col): 落子位置的元组
        """
        # 您的AI逻辑
        return (row, col)
```

## 打擂台规则

1. **起始排名**：新AI从第10名开始挑战
2. **比赛规则**：每场比赛进行10局，胜局多者获胜
3. **排名更新**：
   - 挑战成功：排名上升，继续挑战更高排名
   - 挑战失败：插入到被挑战者后一名
4. **超时机制**：每步棋限时60秒，超时判负

## 目录结构

```
gomoku-platform/
├── server.js              # Express服务器
├── match.py               # 比赛执行脚本
├── package.json           # 项目配置
├── public/                # 前端文件
│   ├── index.html         # 登录页面
│   ├── upload.html        # 上传页面
│   ├── rankings.html      # 排行榜页面
│   └── results.html       # 个人记录页面
├── data/                  # JSON数据文件
│   ├── students.json      # 学生信息
│   ├── rankings.json      # 排行榜数据
│   ├── submissions.json   # 提交记录
│   └── matches.json       # 比赛记录
├── submissions/           # 学生AI代码
├── gomoku/               # 五子棋游戏引擎
│   ├── agent.py          # 基础Agent类
│   ├── gomoku.py         # 游戏核心逻辑
│   └── ...
└── README.md             # 说明文档
```

## 配置选项

### 服务器配置
- 端口：默认3000，可通过环境变量 `PORT` 修改
- Session密钥：在 `server.js` 中修改

### 比赛配置
- 每场比赛局数：默认10局
- 超时时间：默认60秒
- 文件大小限制：默认50KB

## 安全考虑

- ✅ 文件类型验证（仅允许.py文件）
- ✅ 文件大小限制（50KB）
- ✅ 代码内容基础检查
- ✅ 执行超时控制
- ✅ 原子性文件写入
- ✅ Session认证

## API接口

### 认证相关
- `POST /api/login` - 用户登录
- `POST /api/logout` - 用户登出
- `GET /api/auth-status` - 检查登录状态
- `POST /api/change-password` - 修改密码

### 功能相关
- `POST /api/upload` - 上传AI代码
- `GET /api/rankings` - 获取排行榜
- `GET /api/my-results` - 获取个人比赛记录

## 开发扩展

### 添加新学生账户

编辑 `data/students.json` 文件：

```json
{
  "2021006": {
    "password": "hashed_password",
    "name": "新学生",
    "created_at": "2025-01-01T00:00:00.000Z"
  }
}
```

注意：密码需要使用bcrypt加密。

### 修改比赛规则

在 `server.js` 中修改相关参数：
- `num_games`：每场比赛局数
- `PLAYER_TIME_LIMIT`：单步时间限制

### 自定义界面

前端文件在 `public/` 目录下，使用Vue 3 + Bootstrap构建，可以直接修改HTML文件。

## 故障排除

### 常见问题

1. **无法启动服务器**
   - 检查Node.js版本（需要16+）
   - 确保端口3000未被占用

2. **AI代码执行失败**
   - 检查Python环境
   - 确保numpy已安装
   - 查看控制台错误信息

3. **文件上传失败**
   - 检查文件大小（不超过50KB）
   - 确保文件是.py格式
   - 检查文件内容包含必需的类和方法

### 日志查看

服务器日志会在控制台输出，包含：
- 比赛进度信息
- 错误信息
- API请求日志

## 贡献

这是一个教学项目，欢迎提出改进建议和Bug报告。

## 许可证

MIT License

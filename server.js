const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const writeFileAtomic = require('write-file-atomic');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件配置
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session配置
app.use(session({
    secret: 'gomoku-platform-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24小时
}));

// 文件上传配置
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'submissions/');
    },
    filename: (req, file, cb) => {
        const studentId = req.session.studentId;
        cb(null, `agent_${studentId}.py`);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 // 50KB限制
    },
    fileFilter: (req, file, cb) => {
        if (path.extname(file.originalname) !== '.py') {
            return cb(new Error('只允许上传Python文件'));
        }
        cb(null, true);
    }
});

// 工具函数：安全读取JSON文件
async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {};
        }
        throw error;
    }
}

// 工具函数：安全写入JSON文件
async function writeJsonFile(filePath, data) {
    await writeFileAtomic(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// 认证中间件
function requireAuth(req, res, next) {
    if (!req.session.studentId) {
        return res.status(401).json({ error: '请先登录' });
    }
    next();
}

// 初始化数据文件
async function initializeDataFiles() {
    const dataFiles = [
        { path: './data/students.json', default: {} },
        { path: './data/rankings.json', default: { rankings: [] } },
        { path: './data/submissions.json', default: {} },
        { path: './data/matches.json', default: { matches: [] } }
    ];

    for (const file of dataFiles) {
        try {
            await fs.access(file.path);
        } catch {
            await writeJsonFile(file.path, file.default);
        }
    }

    // 创建一些默认学生账户用于测试
    const students = await readJsonFile('./data/students.json');
    if (Object.keys(students).length === 0) {
        const defaultStudents = {};
        for (let i = 1; i <= 5; i++) {
            const studentId = `202100${i}`;
            defaultStudents[studentId] = {
                password: await bcrypt.hash('123456', 10),
                name: `测试学生${i}`,
                created_at: new Date().toISOString()
            };
        }
        await writeJsonFile('./data/students.json', defaultStudents);
        console.log('已创建默认测试账户：2021001-2021005，密码：123456');
    }
}

// API路由

// 登录
app.post('/api/login', async (req, res) => {
    try {
        const { studentId, password } = req.body;

        if (!studentId || !password) {
            return res.status(400).json({ error: '学号和密码不能为空' });
        }

        const students = await readJsonFile('./data/students.json');
        const student = students[studentId];

        if (!student || !await bcrypt.compare(password, student.password)) {
            return res.status(401).json({ error: '学号或密码错误' });
        }

        req.session.studentId = studentId;
        res.json({
            success: true,
            message: '登录成功',
            studentId: studentId,
            name: student.name
        });
    } catch (error) {
        console.error('登录错误:', error);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// 登出
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true, message: '登出成功' });
});

// 检查登录状态
app.get('/api/auth-status', (req, res) => {
    if (req.session.studentId) {
        res.json({
            loggedIn: true,
            studentId: req.session.studentId
        });
    } else {
        res.json({ loggedIn: false });
    }
});

// 修改密码
app.post('/api/change-password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const studentId = req.session.studentId;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: '当前密码和新密码不能为空' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: '新密码长度至少需要6位' });
        }

        const students = await readJsonFile('./data/students.json');
        const student = students[studentId];

        if (!await bcrypt.compare(currentPassword, student.password)) {
            return res.status(401).json({ error: '当前密码错误' });
        }

        students[studentId].password = await bcrypt.hash(newPassword, 10);
        students[studentId].password_updated_at = new Date().toISOString();
        await writeJsonFile('./data/students.json', students);

        res.json({ success: true, message: '密码修改成功' });
    } catch (error) {
        console.error('修改密码错误:', error);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// 上传AI代码
app.post('/api/upload', requireAuth, upload.single('agentFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请选择要上传的文件' });
        }

        const studentId = req.session.studentId;
        const filePath = req.file.path;

        // 验证文件内容
        const fileContent = await fs.readFile(filePath, 'utf8');

        if (!fileContent.includes('class') || !fileContent.includes('make_move')) {
            await fs.unlink(filePath);
            return res.status(400).json({ error: '文件必须包含Agent类和make_move方法' });
        }

        // 更新提交记录
        const submissions = await readJsonFile('./data/submissions.json');
        submissions[studentId] = {
            filename: req.file.filename,
            upload_time: new Date().toISOString(),
            file_path: filePath,
            status: 'active'
        };
        await writeJsonFile('./data/submissions.json', submissions);

        // 如果是首次提交，开始打擂台
        const rankings = await readJsonFile('./data/rankings.json');
        const existingRank = rankings.rankings.find(r => r.student_id === studentId);

        if (!existingRank) {
            // 新AI从第10名开始挑战
            await startChallengeProcess(studentId);
        }

        res.json({
            success: true,
            message: 'AI代码上传成功，正在开始打擂台比赛...',
            filename: req.file.filename
        });
    } catch (error) {
        console.error('上传错误:', error);
        res.status(500).json({ error: error.message || '服务器内部错误' });
    }
});

// 获取排行榜
app.get('/api/rankings', async (req, res) => {
    try {
        const rankings = await readJsonFile('./data/rankings.json');
        res.json(rankings);
    } catch (error) {
        console.error('获取排行榜错误:', error);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// 获取个人比赛记录
app.get('/api/my-results', requireAuth, async (req, res) => {
    try {
        const studentId = req.session.studentId;
        const matches = await readJsonFile('./data/matches.json');

        const myMatches = matches.matches.filter(
            match => match.challenger === studentId || match.defender === studentId
        );

        res.json({ matches: myMatches });
    } catch (error) {
        console.error('获取比赛记录错误:', error);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// 打擂台核心功能
async function startChallengeProcess(challengerStudentId) {
    console.log(`开始为学生 ${challengerStudentId} 进行打擂台挑战`);

    const rankings = await readJsonFile('./data/rankings.json');
    let targetRank = Math.min(10, rankings.rankings.length + 1);

    // 从目标排名开始向上挑战
    while (targetRank >= 1) {
        const defender = rankings.rankings.find(r => r.rank === targetRank);

        if (!defender && targetRank <= rankings.rankings.length) {
            targetRank--;
            continue;
        }

        const result = await runMatch(challengerStudentId, defender ? defender.student_id : null);

        if (result.winner === challengerStudentId) {
            // 挑战成功，更新排名
            await updateRankings(challengerStudentId, targetRank);
            console.log(`学生 ${challengerStudentId} 成功挑战第 ${targetRank} 名`);
            targetRank--; // 继续向上挑战
        } else {
            // 挑战失败，插入到当前位置后一名
            await updateRankings(challengerStudentId, targetRank + 1);
            console.log(`学生 ${challengerStudentId} 挑战失败，排名第 ${targetRank + 1} 名`);
            break;
        }
    }
}

// 执行比赛
async function runMatch(challenger, defender) {
    return new Promise((resolve, reject) => {
        const challengerPath = `./submissions/agent_${challenger}.py`;
        const defenderPath = defender ? `./submissions/agent_${defender}.py` : './gomoku/agent.py';

        console.log(`开始比赛: ${challenger} vs ${defender || 'default'}`);

        const pythonProcess = spawn('python', [
            './gomoku/match.py',
            '--challenger', challengerPath,
            '--defender', defenderPath,
            '--games', '10'
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30000 // 30秒超时
        });

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        pythonProcess.on('close', async (code) => {
            try {
                if (code !== 0) {
                    console.error(`比赛进程异常退出，代码: ${code}, 错误: ${stderr}`);
                    // 如果比赛进程异常，认为挑战者失败
                    resolve({
                        winner: defender || 'default',
                        challenger_wins: 0,
                        defender_wins: 10,
                        error: `比赛进程异常: ${stderr}`
                    });
                    return;
                }

                const result = JSON.parse(stdout);

                // 记录比赛结果
                await recordMatch(challenger, defender, result);

                resolve(result);
            } catch (error) {
                console.error('解析比赛结果失败:', error, 'stdout:', stdout);
                resolve({
                    winner: defender || 'default',
                    challenger_wins: 0,
                    defender_wins: 10,
                    error: '解析结果失败'
                });
            }
        });

        pythonProcess.on('error', (error) => {
            console.error('启动比赛进程失败:', error);
            resolve({
                winner: defender || 'default',
                challenger_wins: 0,
                defender_wins: 10,
                error: '启动进程失败'
            });
        });
    });
}

// 记录比赛结果
async function recordMatch(challenger, defender, result) {
    const matches = await readJsonFile('./data/matches.json');

    const matchRecord = {
        id: `match_${Date.now()}`,
        challenger: challenger,
        defender: defender || 'default',
        winner: result.winner,
        games_played: 10,
        challenger_wins: result.challenger_wins,
        defender_wins: result.defender_wins,
        timestamp: new Date().toISOString()
    };

    matches.matches.push(matchRecord);
    await writeJsonFile('./data/matches.json', matches);
}

// 更新排行榜
async function updateRankings(studentId, newRank) {
    const rankings = await readJsonFile('./data/rankings.json');

    // 移除学生的旧排名
    rankings.rankings = rankings.rankings.filter(r => r.student_id !== studentId);

    // 调整其他学生的排名
    rankings.rankings.forEach(r => {
        if (r.rank >= newRank) {
            r.rank++;
        }
    });

    // 插入新排名
    rankings.rankings.push({
        rank: newRank,
        student_id: studentId,
        wins: 0,
        losses: 0,
        win_rate: 0,
        last_updated: new Date().toISOString()
    });

    // 重新排序并重新编号
    rankings.rankings.sort((a, b) => a.rank - b.rank);
    rankings.rankings.forEach((r, index) => {
        r.rank = index + 1;
    });

    await writeJsonFile('./data/rankings.json', rankings);
}

// 错误处理中间件
app.use((error, req, res, next) => {
    console.error('服务器错误:', error);

    if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: '文件大小超过50KB限制' });
    }

    res.status(500).json({ error: error.message || '服务器内部错误' });
});

// 启动服务器
async function startServer() {
    try {
        await initializeDataFiles();

        app.listen(PORT, () => {
            console.log(`五子棋对战平台已启动在端口 ${PORT}`);
            console.log(`访问 http://localhost:${PORT} 开始使用`);
        });
    } catch (error) {
        console.error('启动服务器失败:', error);
        process.exit(1);
    }
}

startServer();

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

// 日志功能：创建日志目录
async function ensureLogDirectory() {
    try {
        await fs.access('./logs');
    } catch {
        await fs.mkdir('./logs', { recursive: true });
    }
}

// 日志功能：记录错误到文件
async function logError(error, context = '') {
    try {
        await ensureLogDirectory();

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFileName = `error_${timestamp}.log`;
        const logPath = path.join('./logs', logFileName);

        const logContent = {
            timestamp: new Date().toISOString(),
            context: context,
            error: {
                message: error.message,
                stack: error.stack,
                name: error.name
            },
            process: {
                pid: process.pid,
                memory: process.memoryUsage(),
                version: process.version
            }
        };

        await fs.writeFile(logPath, JSON.stringify(logContent, null, 2), 'utf8');
        console.error(`错误已记录到: ${logPath}`);

        return logPath;
    } catch (logError) {
        console.error('记录错误日志失败:', logError);
    }
}

// 日志功能：记录一般信息
async function logInfo(message, data = null) {
    try {
        await ensureLogDirectory();

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFileName = `info_${timestamp}.log`;
        const logPath = path.join('./logs', logFileName);

        const logContent = {
            timestamp: new Date().toISOString(),
            level: 'INFO',
            message: message,
            data: data
        };

        await fs.writeFile(logPath, JSON.stringify(logContent, null, 2), 'utf8');
        console.log(`信息已记录到: ${logPath}`);

        return logPath;
    } catch (error) {
        console.error('记录信息日志失败:', error);
    }
}

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
        await logError(error, `登录失败 - 学号: ${req.body.studentId}`);
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
        await logError(error, `修改密码失败 - 学号: ${req.session.studentId}`);
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

        // 每次提交都开始打擂台
        await startChallengeProcess(studentId);

        res.json({
            success: true,
            message: 'AI代码上传成功，正在开始打擂台比赛...',
            filename: req.file.filename
        });
    } catch (error) {
        await logError(error, `上传AI代码失败 - 学号: ${req.session.studentId}, 文件: ${req.file ? req.file.filename : 'unknown'}`);
        res.status(500).json({ error: error.message || '服务器内部错误' });
    }
});

// 获取排行榜
app.get('/api/rankings', async (req, res) => {
    try {
        const rankings = await readJsonFile('./data/rankings.json');

        // 更新所有学生的统计信息
        for (let i = 0; i < rankings.rankings.length; i++) {
            const player = rankings.rankings[i];
            const playerStats = await calculatePlayerStats(player.student_id);
            player.wins = playerStats.wins;
            player.losses = playerStats.losses;
            player.win_rate = playerStats.winRate;
            player.last_updated = new Date().toISOString();
        }

        // 保存更新后的排行榜
        await writeJsonFile('./data/rankings.json', rankings);

        res.json(rankings);
    } catch (error) {
        await logError(error, '获取排行榜失败');
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
        await logError(error, `获取比赛记录失败 - 学号: ${req.session.studentId}`);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// 打擂台核心功能
async function startChallengeProcess(challengerStudentId) {
    try {
        console.log(`开始为学生 ${challengerStudentId} 进行打擂台挑战`);
        await logInfo(`开始打擂台挑战`, { challengerStudentId });

        const rankings = await readJsonFile('./data/rankings.json');
        const existingRank = rankings.rankings.find(r => r.student_id === challengerStudentId);

        // 确定起始挑战位置
        let targetRank;
        if (rankings.rankings.length < 10) {
            // 如果排行榜人数少于10人，从最后一名开始向上挑战
            targetRank = rankings.rankings.length;
            if (targetRank === 0) targetRank = 1; // 如果排行榜为空，直接成为第1名
        } else {
            // 如果排行榜已有10人或更多，从第10名开始挑战
            targetRank = 10;
        }        // 从目标排名开始向上挑战
        while (targetRank >= 1) {
            const defender = rankings.rankings.find(r => r.rank === targetRank);

            // 特殊处理：如果排行榜为空，直接成为第1名
            if (rankings.rankings.length === 0) {
                await updateRankings(challengerStudentId, 1);
                console.log(`学生 ${challengerStudentId} 成为排行榜第1名！`);
                await logInfo(`成为首位`, {
                    challenger: challengerStudentId,
                    rank: 1
                });
                break;
            }

            // 如果defender不存在
            if (!defender) {
                if (rankings.rankings.length < 10) {
                    // 排行榜人数少于10时，如果没有对应排名的defender，直接插入到末尾
                    const newRank = rankings.rankings.length + 1;
                    await updateRankings(challengerStudentId, newRank);
                    console.log(`学生 ${challengerStudentId} 直接进入排行榜第 ${newRank} 名`);
                    await logInfo(`直接入榜`, {
                        challenger: challengerStudentId,
                        rank: newRank,
                        originalRank: existingRank ? existingRank.rank : '无'
                    });
                    break;
                } else {
                    // 排行榜满员时，跳过空位置
                    targetRank--;
                    continue;
                }
            }

            // 避免和自己比赛
            if (defender && defender.student_id === challengerStudentId) {
                targetRank--;
                continue;
            }

            // 执行比赛（此时defender肯定存在，因为前面已经处理了不存在的情况）
            const result = await runMatch(challengerStudentId, defender.student_id);

            if (result.winner === challengerStudentId) {
                // 挑战成功，更新排名
                await updateRankings(challengerStudentId, targetRank);
                console.log(`学生 ${challengerStudentId} 成功挑战第 ${targetRank} 名`);
                await logInfo(`挑战成功`, {
                    challenger: challengerStudentId,
                    defender: defender.student_id,
                    rank: targetRank,
                    originalRank: existingRank ? existingRank.rank : '无'
                });

                // 如果已经是第1名，停止挑战
                if (targetRank === 1) {
                    console.log(`学生 ${challengerStudentId} 已成为第1名，挑战结束！`);
                    break;
                }

                targetRank--; // 继续向上挑战
            } else {
                // 挑战失败，插入到当前位置后一名
                const finalRank = targetRank + 1;
                await updateRankings(challengerStudentId, finalRank);
                console.log(`学生 ${challengerStudentId} 挑战失败，排名第 ${finalRank} 名`);
                await logInfo(`挑战失败`, {
                    challenger: challengerStudentId,
                    defender: defender.student_id,
                    finalRank: finalRank,
                    originalRank: existingRank ? existingRank.rank : '无'
                });
                break;
            }
        }
    } catch (error) {
        await logError(error, `打擂台挑战失败 - 挑战者: ${challengerStudentId}`);
        console.error(`打擂台挑战失败:`, error);
    }
}

// 执行比赛
async function runMatch(challenger, defender) {
    return new Promise((resolve, reject) => {
        const challengerPath = `./submissions/agent_${challenger}.py`;
        const defenderPath = defender ? `./submissions/agent_${defender}.py` : './gomoku/agent.py';

        console.log(`开始比赛: ${challenger} vs ${defender || 'default'}`);

        const pythonProcess = spawn('python', [
            './match.py',
            '--challenger', challengerPath,
            '--defender', defenderPath,
            '--games', '9',
            '--silent'
        ], {
            stdio: ['pipe', 'pipe', 'pipe']
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
                    const errorMsg = `比赛进程异常退出，代码: ${code}, 错误: ${stderr}`;
                    console.error(errorMsg);
                    console.error(`Python进程详细信息:`);
                    console.error(`- 挑战者路径: ${challengerPath}`);
                    console.error(`- 防守者路径: ${defenderPath}`);
                    console.error(`- 退出代码: ${code}`);
                    console.error(`- 标准输出: ${stdout || '(无输出)'}`);
                    console.error(`- 错误输出: ${stderr || '(无错误输出)'}`);

                    await logError(new Error(errorMsg), `比赛执行失败 - ${challenger} vs ${defender || 'default'} - 详细信息: 退出代码=${code}, stdout=${stdout}, stderr=${stderr}`);

                    // 如果比赛进程异常，认为挑战者失败
                    resolve({
                        winner: defender || 'default',
                        challenger_wins: 0,
                        defender_wins: 9,
                        error: `比赛进程异常: ${stderr}`
                    });
                    return;
                }

                const result = JSON.parse(stdout);

                // 记录比赛结果
                await recordMatch(challenger, defender, result);

                resolve(result);
            } catch (error) {
                const errorMsg = `解析比赛结果失败: ${error.message}`;
                console.error(errorMsg);
                console.error(`解析错误详细信息:`);
                console.error(`- 挑战者: ${challenger}`);
                console.error(`- 防守者: ${defender || 'default'}`);
                console.error(`- 标准输出长度: ${stdout.length}`);
                console.error(`- 标准输出内容: ${stdout.substring(0, 1000)}${stdout.length > 1000 ? '...(截断)' : ''}`);
                console.error(`- 错误输出: ${stderr || '(无错误输出)'}`);
                console.error(`- 解析错误: ${error.stack}`);

                await logError(error, `解析比赛结果失败 - ${challenger} vs ${defender || 'default'} - stdout长度=${stdout.length}, stderr=${stderr}, 原始输出=${stdout}`);

                resolve({
                    winner: defender || 'default',
                    challenger_wins: 0,
                    defender_wins: 9,
                    error: '解析结果失败'
                });
            }
        });

        pythonProcess.on('error', async (error) => {
            console.error('启动比赛进程失败:', error.message);
            console.error(`进程启动错误详细信息:`);
            console.error(`- 错误类型: ${error.name}`);
            console.error(`- 错误代码: ${error.code || '未知'}`);
            console.error(`- 错误信号: ${error.signal || '未知'}`);
            console.error(`- 完整错误: ${error.stack}`);
            console.error(`- 挑战者路径: ${challengerPath}`);
            console.error(`- 防守者路径: ${defenderPath}`);

            await logError(error, `启动比赛进程失败 - ${challenger} vs ${defender || 'default'} - 错误代码=${error.code}, 信号=${error.signal}`);

            resolve({
                winner: defender || 'default',
                challenger_wins: 0,
                defender_wins: 9,
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
        games_played: 9,
        challenger_wins: result.challenger_wins,
        defender_wins: result.defender_wins,
        timestamp: new Date().toISOString()
    };

    matches.matches.push(matchRecord);
    await writeJsonFile('./data/matches.json', matches);
}

// 计算学生的胜败统计
async function calculatePlayerStats(studentId) {
    const matches = await readJsonFile('./data/matches.json');
    let wins = 0;
    let losses = 0;

    matches.matches.forEach(match => {
        if (match.challenger === studentId) {
            if (match.winner === 'challenger' || match.winner === studentId) {
                wins++;
            } else {
                losses++;
            }
        } else if (match.defender === studentId) {
            if (match.winner === 'defender' || match.winner === studentId) {
                wins++;
            } else {
                losses++;
            }
        }
    });

    const totalGames = wins + losses;
    const winRate = totalGames > 0 ? wins / totalGames : 0;

    return { wins, losses, winRate };
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

    // 计算学生的实际胜败统计
    const stats = await calculatePlayerStats(studentId);

    // 插入新排名
    rankings.rankings.push({
        rank: newRank,
        student_id: studentId,
        wins: stats.wins,
        losses: stats.losses,
        win_rate: stats.winRate,
        last_updated: new Date().toISOString()
    });

    // 重新排序并重新编号，同时更新所有学生的统计信息
    rankings.rankings.sort((a, b) => a.rank - b.rank);

    // 更新所有学生的统计信息
    for (let i = 0; i < rankings.rankings.length; i++) {
        const player = rankings.rankings[i];
        const playerStats = await calculatePlayerStats(player.student_id);
        player.rank = i + 1;
        player.wins = playerStats.wins;
        player.losses = playerStats.losses;
        player.win_rate = playerStats.winRate;
        player.last_updated = new Date().toISOString();
    }

    await writeJsonFile('./data/rankings.json', rankings);
}

// 错误处理中间件
app.use(async (error, req, res, next) => {
    const context = `HTTP ${req.method} ${req.url} - IP: ${req.ip}`;
    await logError(error, context);

    if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: '文件大小超过50KB限制' });
    }

    res.status(500).json({ error: error.message || '服务器内部错误' });
});

// 启动服务器
async function startServer() {
    try {
        await ensureLogDirectory();
        await initializeDataFiles();

        app.listen(PORT, () => {
            console.log(`五子棋对战平台已启动在端口 ${PORT}`);
            console.log(`访问 http://localhost:${PORT} 开始使用`);
            console.log(`日志文件保存在 ./logs 目录下`);
        });
    } catch (error) {
        await logError(error, '启动服务器失败');
        console.error('启动服务器失败:', error);
        process.exit(1);
    }
}

// 处理未捕获的异常
process.on('uncaughtException', async (error) => {
    await logError(error, '未捕获的异常');
    console.error('未捕获的异常:', error);
    process.exit(1);
});

// 处理未处理的Promise拒绝
process.on('unhandledRejection', async (reason, promise) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    await logError(error, `未处理的Promise拒绝 - Promise: ${promise}`);
    console.error('未处理的Promise拒绝:', reason);
});

startServer();

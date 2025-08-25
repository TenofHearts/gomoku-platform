const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const writeFileAtomic = require('write-file-atomic');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { spawn } = require('child_process');
const chalk = require('chalk');

const app = express();
const PORT = process.env.PORT || 3000;

class ChallengeQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
    }

    addChallenger(submissionId) {
        if (this.queue.includes(submissionId)) {
            Logger.warn(`提交 ${submissionId} 已在挑战队列中，跳过重复添加`);
            return false;
        }

        this.queue.push(submissionId);
        Logger.info(`提交 ${submissionId} 已加入挑战队列，当前队列长度: ${this.queue.length}`);

        if (!this.isProcessing) {
            this.processNext();
        }

        return true;
    }

    async processNext() {
        if (this.queue.length === 0) {
            this.isProcessing = false;
            Logger.info('挑战队列为空，等待新的挑战者');
            return;
        }

        if (this.isProcessing) {
            Logger.debug('正在处理其他挑战者，等待完成');
            return;
        }

        this.isProcessing = true;
        const currentChallengerSubmissionId = this.queue.shift();

        Logger.info(`开始处理挑战者: ${currentChallengerSubmissionId}，剩余队列长度: ${this.queue.length}`);

        try {
            await startChallengeProcess(currentChallengerSubmissionId);
            Logger.success(`挑战者 ${currentChallengerSubmissionId} 的所有对局已完成`);
        } catch (error) {
            Logger.error(`处理挑战者 ${currentChallengerSubmissionId} 时发生错误:`, error);
            await logError(error, `处理挑战者队列失败 - 挑战者: ${currentChallengerSubmissionId}`);
        }

        this.isProcessing = false;

        if (this.queue.length > 0) {
            Logger.info(`继续处理队列中的下一个挑战者，剩余: ${this.queue.length} 个`);
            setTimeout(() => this.processNext(), 1000);
        } else {
            Logger.info('所有挑战者已处理完成，挑战队列为空');
        }
    }

    getStatus() {
        return {
            queueLength: this.queue.length,
            isProcessing: this.isProcessing,
            queue: [...this.queue]
        };
    }

    removeChallenger(submissionId) {
        const index = this.queue.indexOf(submissionId);
        if (index > -1) {
            this.queue.splice(index, 1);
            Logger.info(`已从挑战队列中移除提交 ${submissionId}`);
            return true;
        }
        return false;
    }
}

const challengeQueue = new ChallengeQueue();

class Logger {
    static formatTime() {
        return new Date().toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
    }

    static getCallerInfo() {
        const stack = new Error().stack.split('\n');
        const caller = stack[3];
        const match = caller ? caller.match(/at (.+) \((.+):(\d+):(\d+)\)/) || caller.match(/at (.+):(\d+):(\d+)/) : null;
        if (match) {
            if (match.length === 5) {
                const func = match[1];
                const file = path.basename(match[2]);
                const line = match[3];
                return `${file}:${line} ${func}`;
            } else {
                const file = path.basename(match[1]);
                const line = match[2];
                return `${file}:${line}`;
            }
        }
        return 'unknown';
    }

    static formatMessage(level, message, data = null) {
        const timestamp = chalk.gray(`[${this.formatTime()}]`);
        const caller = chalk.dim(`(${this.getCallerInfo()})`);
        let levelStr = '';

        switch (level.toUpperCase()) {
            case 'INFO':
                levelStr = chalk.green.bold('[INFO]');
                break;
            case 'WARN':
                levelStr = chalk.yellow.bold('[WARN]');
                break;
            case 'ERROR':
                levelStr = chalk.red.bold('[ERROR]');
                break;
            case 'DEBUG':
                levelStr = chalk.blue.bold('[DEBUG]');
                break;
            case 'SUCCESS':
                levelStr = chalk.green.bold('[SUCCESS]');
                break;
            default:
                levelStr = chalk.white.bold(`[${level.toUpperCase()}]`);
        }

        let result = `${timestamp} ${levelStr} ${message}`;

        if (data) {
            if (typeof data === 'object') {
                result += '\n' + chalk.dim(JSON.stringify(data, null, 2));
            } else {
                result += chalk.dim(` - ${data}`);
            }
        }

        result += ` ${caller}`;
        return result;
    }

    static info(message, data = null) {
        console.log(this.formatMessage('INFO', message, data));
    }

    static warn(message, data = null) {
        console.warn(this.formatMessage('WARN', message, data));
    }

    static error(message, data = null) {
        console.error(this.formatMessage('ERROR', message, data));
    }

    static debug(message, data = null) {
        console.log(this.formatMessage('DEBUG', message, data));
    }

    static success(message, data = null) {
        console.log(this.formatMessage('SUCCESS', message, data));
    }

    static match(message, data = null) {
        console.log(this.formatMessage('MATCH', chalk.cyan(message), data));
    }

    static server(message, data = null) {
        console.log(this.formatMessage('SERVER', chalk.magenta(message), data));
    }
}

async function ensureLogDirectory() {
    try {
        await fs.access('./logs');
    } catch {
        await fs.mkdir('./logs', { recursive: true });
    }
}

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
        Logger.error(`错误已记录到: ${logPath}`);

        return logPath;
    } catch (logError) {
        Logger.error('记录错误日志失败:', logError);
    }
}

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
        Logger.info(`信息已记录到: ${logPath}`);

        return logPath;
    } catch (error) {
        Logger.error('记录信息日志失败:', error);
    }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: 'gomoku-platform-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24小时
}));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'submissions/');
    },
    filename: (req, file, cb) => {
        // 现在每次提交都创建一个新的文件，而不是覆盖原有文件
        const timestamp = Date.now();
        const studentId = req.session.studentId;
        cb(null, `agent_${studentId}_${timestamp}.py`);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024
    },
    fileFilter: (req, file, cb) => {
        if (path.extname(file.originalname) !== '.py') {
            return cb(new Error('只允许上传Python文件'));
        }
        cb(null, true);
    }
});

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

async function writeJsonFile(filePath, data) {
    await writeFileAtomic(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function getSubmissionById(submissionId) {
    const submissionHistory = await readJsonFile('./data/submission_history.json');
    return submissionHistory.submissions.find(sub => sub.submission_id === submissionId);
}

async function getSubmissionsByStudentId(studentId) {
    const submissionHistory = await readJsonFile('./data/submission_history.json');
    return submissionHistory.submissions.filter(sub => sub.student_id === studentId).sort((a, b) => new Date(b.upload_time) - new Date(a.upload_time));
}

async function updateSubmissionStatus(submissionId, status) {
    const submissionHistory = await readJsonFile('./data/submission_history.json');
    const submission = submissionHistory.submissions.find(sub => sub.submission_id === submissionId);

    if (submission) {
        submission.status = status;
        submission.status_updated = new Date().toISOString();
        await writeJsonFile('./data/submission_history.json', submissionHistory);
        Logger.info(`提交 ${submissionId} 状态更新为: ${status}`);
    }
}

function requireAuth(req, res, next) {
    if (!req.session.studentId) {
        return res.status(401).json({ error: '请先登录' });
    }
    next();
}

async function initializeDataFiles() {
    const dataFiles = [
        { path: './data/students.json', default: {} },
        { path: './data/rankings.json', default: { rankings: [] } },
        { path: './data/submission_history.json', default: { submissions: [], counter: 0 } },
        { path: './data/matches.json', default: { matches: [] } }
    ];

    for (const file of dataFiles) {
        try {
            await fs.access(file.path);
        } catch {
            await writeJsonFile(file.path, file.default);
        }
    }

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
        Logger.success('已创建默认测试账户：2021001-2021005，密码：123456');
    }
}

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

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true, message: '登出成功' });
});

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

app.post('/api/upload', requireAuth, upload.single('agentFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请选择要上传的文件' });
        }

        const studentId = req.session.studentId;
        const filePath = req.file.path;

        const fileContent = await fs.readFile(filePath, 'utf8');

        if (!fileContent.includes('class') || !fileContent.includes('make_move')) {
            await fs.unlink(filePath);
            return res.status(400).json({ error: '文件必须包含Agent类和make_move方法' });
        }

        // 生成唯一的提交ID
        const submissionHistory = await readJsonFile('./data/submission_history.json');
        submissionHistory.counter = (submissionHistory.counter || 0) + 1;
        const submissionId = `SUB${submissionHistory.counter.toString().padStart(6, '0')}`;

        // 使用提交ID重命名文件
        const newFileName = `${submissionId}.py`;
        const newFilePath = path.join('submissions', newFileName);
        await fs.rename(filePath, newFilePath);

        // 创建新的提交记录
        const newSubmission = {
            submission_id: submissionId,
            student_id: studentId,
            filename: newFileName,
            original_filename: req.file.originalname,
            file_path: newFilePath,
            upload_time: new Date().toISOString(),
            status: 'waiting', // 等待测试
            file_size: req.file.size
        };

        submissionHistory.submissions.push(newSubmission);
        await writeJsonFile('./data/submission_history.json', submissionHistory);

        const added = challengeQueue.addChallenger(submissionId);
        const queueStatus = challengeQueue.getStatus();

        if (added) {
            res.json({
                success: true,
                message: `AI代码上传成功！提交ID: ${submissionId}，您已加入挑战队列，当前队列位置: ${queueStatus.queueLength}`,
                submission_id: submissionId,
                filename: newFileName,
                queueInfo: {
                    position: queueStatus.queueLength,
                    isProcessing: queueStatus.isProcessing,
                    totalInQueue: queueStatus.queueLength
                }
            });
        } else {
            res.json({
                success: true,
                message: `AI代码上传成功！提交ID: ${submissionId}，您已在挑战队列中，请等待轮到您的回合`,
                submission_id: submissionId,
                filename: newFileName,
                queueInfo: queueStatus
            });
        }
    } catch (error) {
        await logError(error, `上传AI代码失败 - 学号: ${req.session.studentId}, 文件: ${req.file ? req.file.filename : 'unknown'}`);
        res.status(500).json({ error: error.message || '服务器内部错误' });
    }
});

app.get('/api/rankings', async (req, res) => {
    try {
        const rankings = await readJsonFile('./data/rankings.json');

        // 为每个排名条目更新统计信息并获取提交详情
        for (let i = 0; i < rankings.rankings.length; i++) {
            const player = rankings.rankings[i];

            // 如果是旧格式（只有student_id），需要找到对应的submission_id
            if (!player.submission_id && player.student_id) {
                // 从submission_history中找到该学生的最新提交
                const studentSubmissions = await getSubmissionsByStudentId(player.student_id);
                if (studentSubmissions.length > 0) {
                    player.submission_id = studentSubmissions[0].submission_id; // 最新的提交
                }
            }

            if (player.submission_id) {
                const submission = await getSubmissionById(player.submission_id);
                if (submission) {
                    player.upload_time = submission.upload_time;
                    player.filename = submission.filename;
                }

                const playerStats = await calculatePlayerStats(player.submission_id);
                player.wins = playerStats.wins;
                player.losses = playerStats.losses;
                player.win_rate = playerStats.winRate;
            } else {
                // 兼容旧数据
                const playerStats = await calculatePlayerStats(player.student_id);
                player.wins = playerStats.wins;
                player.losses = playerStats.losses;
                player.win_rate = playerStats.winRate;
            }

            player.last_updated = new Date().toISOString();
        }

        await writeJsonFile('./data/rankings.json', rankings);

        res.json(rankings);
    } catch (error) {
        await logError(error, '获取排行榜失败');
        res.status(500).json({ error: '服务器内部错误' });
    }
});

app.get('/api/my-results', requireAuth, async (req, res) => {
    try {
        const studentId = req.session.studentId;
        const matches = await readJsonFile('./data/matches.json');

        // 获取该学生的所有提交
        const studentSubmissions = await getSubmissionsByStudentId(studentId);
        const submissionIds = studentSubmissions.map(sub => sub.submission_id);

        const myMatches = matches.matches.filter(match => {
            // 支持新的提交ID格式和旧的学生ID格式
            const challengerId = match.challenger_submission_id || match.challenger;
            const defenderId = match.defender_submission_id || match.defender;

            return challengerId === studentId || defenderId === studentId ||
                submissionIds.includes(challengerId) || submissionIds.includes(defenderId);
        });

        // 为每个比赛添加提交详情
        for (let match of myMatches) {
            if (match.challenger_submission_id) {
                const challengerSubmission = await getSubmissionById(match.challenger_submission_id);
                if (challengerSubmission) {
                    match.challenger_submission_details = challengerSubmission;
                }
            }

            if (match.defender_submission_id && match.defender_submission_id !== 'default') {
                const defenderSubmission = await getSubmissionById(match.defender_submission_id);
                if (defenderSubmission) {
                    match.defender_submission_details = defenderSubmission;
                }
            }
        }

        res.json({
            matches: myMatches,
            submissions: studentSubmissions
        });
    } catch (error) {
        await logError(error, `获取比赛记录失败 - 学号: ${req.session.studentId}`);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

app.get('/api/challenge-queue', async (req, res) => {
    try {
        const queueStatus = challengeQueue.getStatus();
        res.json({
            success: true,
            queue: queueStatus
        });
    } catch (error) {
        await logError(error, '获取挑战队列状态失败');
        res.status(500).json({ error: '服务器内部错误' });
    }
});

app.get('/api/my-queue-status', requireAuth, async (req, res) => {
    try {
        const studentId = req.session.studentId;
        const queueStatus = challengeQueue.getStatus();

        // 获取该学生的所有提交
        const studentSubmissions = await getSubmissionsByStudentId(studentId);
        const submissionIds = studentSubmissions.map(sub => sub.submission_id);

        // 查找学生的提交是否在队列中
        const inQueueSubmissions = queueStatus.queue.filter(submissionId => submissionIds.includes(submissionId));
        const earliestPosition = inQueueSubmissions.length > 0 ?
            Math.min(...inQueueSubmissions.map(subId => queueStatus.queue.indexOf(subId))) : -1;

        res.json({
            success: true,
            inQueue: inQueueSubmissions.length > 0,
            position: earliestPosition !== -1 ? earliestPosition + 1 : null,
            inQueueSubmissions: inQueueSubmissions,
            isCurrentlyProcessing: queueStatus.isProcessing && earliestPosition === 0,
            totalInQueue: queueStatus.queueLength,
            estimatedWaitTime: earliestPosition > 0 ? earliestPosition * 30 : 0
        });
    } catch (error) {
        await logError(error, `获取个人队列状态失败 - 学号: ${req.session.studentId}`);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// 新增API：获取学生的所有提交历史
app.get('/api/my-submissions', requireAuth, async (req, res) => {
    try {
        const studentId = req.session.studentId;
        const submissions = await getSubmissionsByStudentId(studentId);

        // 为每个提交计算统计信息
        for (let submission of submissions) {
            const stats = await calculatePlayerStats(submission.submission_id);
            submission.stats = stats;

            // 获取排名信息
            const rankings = await readJsonFile('./data/rankings.json');
            const ranking = rankings.rankings.find(r => r.submission_id === submission.submission_id);
            submission.current_rank = ranking ? ranking.rank : null;
        }

        res.json({
            success: true,
            submissions: submissions
        });
    } catch (error) {
        await logError(error, `获取提交历史失败 - 学号: ${req.session.studentId}`);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// 新增API：获取特定提交的详细信息
app.get('/api/submission/:submissionId', requireAuth, async (req, res) => {
    try {
        const submissionId = req.params.submissionId;
        const studentId = req.session.studentId;

        const submission = await getSubmissionById(submissionId);
        if (!submission) {
            return res.status(404).json({ error: '提交不存在' });
        }

        // 验证权限
        if (submission.student_id !== studentId) {
            return res.status(403).json({ error: '无权限访问该提交' });
        }

        // 获取统计信息
        const stats = await calculatePlayerStats(submissionId);
        submission.stats = stats;

        // 获取排名信息
        const rankings = await readJsonFile('./data/rankings.json');
        const ranking = rankings.rankings.find(r => r.submission_id === submissionId);
        submission.current_rank = ranking ? ranking.rank : null;

        // 获取相关比赛
        const matches = await readJsonFile('./data/matches.json');
        const relatedMatches = matches.matches.filter(match => {
            const challengerId = match.challenger_submission_id || match.challenger;
            const defenderId = match.defender_submission_id || match.defender;
            return challengerId === submissionId || defenderId === submissionId;
        });

        res.json({
            success: true,
            submission: submission,
            matches: relatedMatches
        });
    } catch (error) {
        await logError(error, `获取提交详情失败 - 提交ID: ${req.params.submissionId}`);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// 新增API：下载历史代码
app.get('/api/download/:submissionId', requireAuth, async (req, res) => {
    try {
        const submissionId = req.params.submissionId;
        const studentId = req.session.studentId;

        const submission = await getSubmissionById(submissionId);
        if (!submission) {
            return res.status(404).json({ error: '提交不存在' });
        }

        // 验证权限
        if (submission.student_id !== studentId) {
            return res.status(403).json({ error: '无权限下载该提交' });
        }

        // 检查文件是否存在
        try {
            await fs.access(submission.file_path);
        } catch {
            return res.status(404).json({ error: '文件不存在' });
        }

        const fileContent = await fs.readFile(submission.file_path, 'utf8');

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${submission.original_filename || submission.filename}"`);
        res.send(fileContent);

        Logger.info(`学生 ${studentId} 下载了提交 ${submissionId} 的代码文件`);
    } catch (error) {
        await logError(error, `下载代码失败 - 提交ID: ${req.params.submissionId}, 学号: ${req.session.studentId}`);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

app.post('/api/admin/clear-queue', async (req, res) => {
    try {
        const { adminKey } = req.body;

        if (adminKey !== 'admin123') {
            return res.status(403).json({ error: '无权限操作' });
        }

        const oldStatus = challengeQueue.getStatus();
        challengeQueue.queue = [];
        challengeQueue.isProcessing = false;

        Logger.warn('管理员清理了挑战队列', oldStatus);

        res.json({
            success: true,
            message: '挑战队列已清理',
            previousStatus: oldStatus
        });
    } catch (error) {
        await logError(error, '清理挑战队列失败');
        res.status(500).json({ error: '服务器内部错误' });
    }
});

async function startChallengeProcess(challengerSubmissionId) {
    try {
        Logger.info(`========== 开始处理挑战者提交 ${challengerSubmissionId} ==========`);

        // 更新状态为测试中
        await updateSubmissionStatus(challengerSubmissionId, 'testing');

        const challengerSubmission = await getSubmissionById(challengerSubmissionId);
        if (!challengerSubmission) {
            throw new Error(`找不到提交ID: ${challengerSubmissionId}`);
        }

        const challengerStudentId = challengerSubmission.student_id;
        Logger.info(`开始为提交 ${challengerSubmissionId} (学生 ${challengerStudentId}) 进行打擂台挑战`);
        await logInfo(`开始打擂台挑战`, { challengerSubmissionId, challengerStudentId });

        const rankings = await readJsonFile('./data/rankings.json');
        const existingRank = rankings.rankings.find(r => r.submission_id === challengerSubmissionId);

        let targetRank;
        if (rankings.rankings.length < 10) {
            targetRank = rankings.rankings.length;
            if (targetRank === 0) targetRank = 1;
        } else {
            targetRank = 10;
        }

        while (targetRank >= 1) {
            const defender = rankings.rankings.find(r => r.rank === targetRank);

            if (rankings.rankings.length === 0) {
                await updateRankings(challengerSubmissionId, 1);
                Logger.success(`提交 ${challengerSubmissionId} 成为排行榜第1名！`);
                await logInfo(`成为首位`, {
                    challengerSubmissionId,
                    challengerStudentId,
                    rank: 1
                });
                break;
            }

            if (!defender) {
                if (rankings.rankings.length < 10) {
                    const newRank = rankings.rankings.length + 1;
                    await updateRankings(challengerSubmissionId, newRank);
                    Logger.success(`提交 ${challengerSubmissionId} 直接进入排行榜第 ${newRank} 名`);
                    await logInfo(`直接入榜`, {
                        challengerSubmissionId,
                        challengerStudentId,
                        rank: newRank,
                        originalRank: existingRank ? existingRank.rank : '无'
                    });
                    break;
                } else {
                    targetRank--;
                    continue;
                }
            }

            // 检查是否是同一个学生的提交，如果是则跳过
            if (defender) {
                const defenderSubmission = await getSubmissionById(defender.submission_id);
                if (defenderSubmission && defenderSubmission.student_id === challengerStudentId) {
                    Logger.info(`跳过同学生的提交对战: ${challengerSubmissionId} vs ${defender.submission_id}`);
                    targetRank--;
                    continue;
                }
            }

            if (defender && defender.submission_id === challengerSubmissionId) {
                targetRank--;
                continue;
            }

            const result = await runMatch(challengerSubmissionId, defender.submission_id);

            if (result.winner === 'challenger') {
                await updateRankings(challengerSubmissionId, targetRank);
                Logger.success(`提交 ${challengerSubmissionId} 成功挑战第 ${targetRank} 名`);
                await logInfo(`挑战成功`, {
                    challengerSubmissionId,
                    challengerStudentId,
                    defenderSubmissionId: defender.submission_id,
                    rank: targetRank,
                    originalRank: existingRank ? existingRank.rank : '无'
                });

                if (targetRank === 1) {
                    Logger.success(`提交 ${challengerSubmissionId} 已成为第1名，挑战结束！`);
                    break;
                }

                targetRank--;
            } else {
                const finalRank = targetRank + 1;
                await updateRankings(challengerSubmissionId, finalRank);
                Logger.warn(`提交 ${challengerSubmissionId} 挑战失败，排名第 ${finalRank} 名`);
                await logInfo(`挑战失败`, {
                    challengerSubmissionId,
                    challengerStudentId,
                    defenderSubmissionId: defender.submission_id,
                    finalRank: finalRank,
                    originalRank: existingRank ? existingRank.rank : '无'
                });
                break;
            }
        }

        Logger.info(`========== 挑战者提交 ${challengerSubmissionId} 所有对局完成 ==========`);

        // 更新状态为已完成
        await updateSubmissionStatus(challengerSubmissionId, 'completed');
    } catch (error) {
        // 如果出错，将状态更新为错误
        await updateSubmissionStatus(challengerSubmissionId, 'error');
        await logError(error, `打擂台挑战失败 - 挑战者提交: ${challengerSubmissionId}`);
        Logger.error(`打擂台挑战失败:`, error);
        throw error;
    }
}

async function runMatch(challengerSubmissionId, defenderSubmissionId) {
    return new Promise(async (resolve, reject) => {
        try {
            const challengerSubmission = await getSubmissionById(challengerSubmissionId);
            const defenderSubmission = defenderSubmissionId ? await getSubmissionById(defenderSubmissionId) : null;

            if (!challengerSubmission) {
                throw new Error(`找不到挑战者提交: ${challengerSubmissionId}`);
            }

            const challengerPath = challengerSubmission.file_path;
            const defenderPath = defenderSubmission ? defenderSubmission.file_path : './gomoku/agent.py';

            Logger.match(`开始比赛: ${challengerSubmissionId} vs ${defenderSubmissionId || 'default'}`);

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
                        Logger.error(errorMsg);
                        Logger.debug(`Python进程详细信息:`);
                        Logger.debug(`- 挑战者路径: ${challengerPath}`);
                        Logger.debug(`- 防守者路径: ${defenderPath}`);
                        Logger.debug(`- 退出代码: ${code}`);
                        Logger.debug(`- 标准输出: ${stdout || '(无输出)'}`);
                        Logger.debug(`- 错误输出: ${stderr || '(无错误输出)'}`);

                        await logError(new Error(errorMsg), `比赛执行失败 - ${challengerSubmissionId} vs ${defenderSubmissionId || 'default'} - 详细信息: 退出代码=${code}, stdout=${stdout}, stderr=${stderr}`);

                        resolve({
                            winner: defenderSubmissionId || 'default',
                            challenger_wins: 0,
                            defender_wins: 9,
                            error: `比赛进程异常: ${stderr}`
                        });
                        return;
                    }

                    const result = JSON.parse(stdout);

                    await recordMatch(challengerSubmissionId, defenderSubmissionId, result);

                    resolve(result);
                } catch (error) {
                    const errorMsg = `解析比赛结果失败: ${error.message}`;
                    Logger.error(errorMsg);
                    Logger.debug(`解析错误详细信息:`);
                    Logger.debug(`- 挑战者: ${challengerSubmissionId}`);
                    Logger.debug(`- 防守者: ${defenderSubmissionId || 'default'}`);
                    Logger.debug(`- 标准输出长度: ${stdout.length}`);
                    Logger.debug(`- 标准输出内容: ${stdout.substring(0, 1000)}${stdout.length > 1000 ? '...(截断)' : ''}`);
                    Logger.debug(`- 错误输出: ${stderr || '(无错误输出)'}`);
                    Logger.debug(`- 解析错误: ${error.stack}`);

                    await logError(error, `解析比赛结果失败 - ${challengerSubmissionId} vs ${defenderSubmissionId || 'default'} - stdout长度=${stdout.length}, stderr=${stderr}, 原始输出=${stdout}`);

                    resolve({
                        winner: defenderSubmissionId || 'default',
                        challenger_wins: 0,
                        defender_wins: 9,
                        error: '解析结果失败'
                    });
                }
            });

            pythonProcess.on('error', async (error) => {
                Logger.error('启动比赛进程失败:', error.message);
                Logger.debug(`进程启动错误详细信息:`);
                Logger.debug(`- 错误类型: ${error.name}`);
                Logger.debug(`- 错误代码: ${error.code || '未知'}`);
                Logger.debug(`- 错误信号: ${error.signal || '未知'}`);
                Logger.debug(`- 完整错误: ${error.stack}`);
                Logger.debug(`- 挑战者路径: ${challengerPath}`);
                Logger.debug(`- 防守者路径: ${defenderPath}`);

                await logError(error, `启动比赛进程失败 - ${challengerSubmissionId} vs ${defenderSubmissionId || 'default'} - 错误代码=${error.code}, 信号=${error.signal}`);

                resolve({
                    winner: defenderSubmissionId || 'default',
                    challenger_wins: 0,
                    defender_wins: 9,
                    error: '启动进程失败'
                });
            });
        } catch (error) {
            Logger.error('比赛执行前准备失败:', error);
            await logError(error, `比赛准备失败 - ${challengerSubmissionId} vs ${defenderSubmissionId || 'default'}`);
            resolve({
                winner: defenderSubmissionId || 'default',
                challenger_wins: 0,
                defender_wins: 9,
                error: '比赛准备失败'
            });
        }
    });
}

async function recordMatch(challengerSubmissionId, defenderSubmissionId, result) {
    const matches = await readJsonFile('./data/matches.json');

    const challengerSubmission = await getSubmissionById(challengerSubmissionId);
    const defenderSubmission = defenderSubmissionId ? await getSubmissionById(defenderSubmissionId) : null;

    let actualWinner;
    if (result.winner === 'challenger') {
        actualWinner = challengerSubmissionId;
    } else if (result.winner === 'defender') {
        actualWinner = defenderSubmissionId || 'default';
    } else if (result.winner === 'tie') {
        actualWinner = 'tie';
    } else {
        actualWinner = result.winner;
    }

    const matchRecord = {
        id: `match_${Date.now()}`,
        challenger_submission_id: challengerSubmissionId,
        challenger_student_id: challengerSubmission.student_id,
        defender_submission_id: defenderSubmissionId || 'default',
        defender_student_id: defenderSubmission ? defenderSubmission.student_id : 'default',
        winner: actualWinner,
        games_played: 9,
        challenger_wins: result.challenger_wins,
        defender_wins: result.defender_wins,
        timestamp: new Date().toISOString(),
        total_duration: result.games ? result.games.reduce((sum, game) => sum + game.duration, 0) : 0,
        average_game_duration: result.games && result.games.length > 0 ? result.games.reduce((sum, game) => sum + game.duration, 0) / result.games.length : 0
    };

    matches.matches.push(matchRecord);
    await writeJsonFile('./data/matches.json', matches);

    await logMatchDetails(challengerSubmissionId, defenderSubmissionId, result);
}

async function logMatchDetails(challengerSubmissionId, defenderSubmissionId, result) {
    try {
        await ensureLogDirectory();

        const challengerSubmission = await getSubmissionById(challengerSubmissionId);
        const defenderSubmission = defenderSubmissionId ? await getSubmissionById(defenderSubmissionId) : null;

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFileName = `match_detail_${challengerSubmissionId}_vs_${defenderSubmissionId || 'default'}_${timestamp}.log`;
        const logPath = path.join('./logs', logFileName);

        let logContent = '';

        logContent += '='.repeat(80) + '\n';
        logContent += '                            五子棋对战详细记录\n';
        logContent += '='.repeat(80) + '\n';
        logContent += `对战时间: ${new Date().toLocaleString('zh-CN')}\n`;
        logContent += `挑战者提交: ${challengerSubmissionId} (学生: ${challengerSubmission.student_id})\n`;
        logContent += `防守者提交: ${defenderSubmissionId || 'default'} ${defenderSubmission ? `(学生: ${defenderSubmission.student_id})` : ''}\n`;
        logContent += '-'.repeat(80) + '\n';
        logContent += `比赛结果: ${getWinnerDisplayName(result.winner, challengerSubmissionId, defenderSubmissionId)}\n`;
        logContent += `总局数: ${result.total_games || 0}\n`;
        logContent += `挑战者胜利: ${result.challenger_wins || 0} 局\n`;
        logContent += `防守者胜利: ${result.defender_wins || 0} 局\n`;
        if (result.challenger_win_rate !== undefined) {
            logContent += `挑战者胜率: ${(result.challenger_win_rate * 100).toFixed(1)}%\n`;
            logContent += `防守者胜率: ${(result.defender_win_rate * 100).toFixed(1)}%\n`;
        }
        logContent += '='.repeat(80) + '\n\n';

        if (result.games && result.games.length > 0) {
            for (let i = 0; i < result.games.length; i++) {
                const game = result.games[i];
                logContent += `第 ${game.game} 局游戏详情\n`;
                logContent += '-'.repeat(40) + '\n';
                logContent += `先手: ${game.challenger_first ? '挑战者' : '防守者'} (${game.challenger_first ? challengerSubmissionId : (defenderSubmissionId || 'default')})\n`;
                logContent += `获胜者: ${getGameWinnerDisplayName(game.winner, challengerSubmissionId, defenderSubmissionId)}\n`;
                logContent += `游戏时长: ${game.duration.toFixed(2)} 秒\n`;

                if (game.game_record && game.game_record.moves) {
                    const moves = game.game_record.moves;
                    const boardSize = game.game_record.board_size || 15;

                    logContent += `棋盘大小: ${boardSize}x${boardSize}\n`;
                    logContent += `总步数: ${game.game_record.total_moves || 0}\n`;
                    logContent += `平均每步时间: ${(game.game_record.average_move_time || 0).toFixed(3)} 秒\n`;

                    if (game.game_record.player_statistics) {
                        const stats = game.game_record.player_statistics;
                        logContent += `玩家1统计: ${stats[1].moves}步, 平均${stats[1].average_time.toFixed(3)}秒/步\n`;
                        logContent += `玩家2统计: ${stats[2].moves}步, 平均${stats[2].average_time.toFixed(3)}秒/步\n`;
                    }

                    logContent += '\n棋谱记录:\n';
                    logContent += '步数 | 玩家 | 位置     | 用时(秒) | 状态\n';
                    logContent += '-'.repeat(45) + '\n';

                    moves.forEach((move, index) => {
                        const stepNum = String(move.move_number).padStart(4);
                        const player = `玩家${move.player}`;
                        const position = move.move ? `(${move.move[0].toString().padStart(2)},${move.move[1].toString().padStart(2)})` : '  --  ';
                        const time = move.time_taken.toFixed(3).padStart(7);
                        const status = getStatusDisplayName(move.result);

                        logContent += `${stepNum} | ${player} | ${position} | ${time} | ${status}\n`;

                        if (move.error) {
                            logContent += `     └─ 错误: ${move.error}\n`;
                        }
                    });

                    if (game.game_record.board_states && game.game_record.board_states.length > 0) {
                        const finalBoard = game.game_record.board_states[game.game_record.board_states.length - 1];
                        logContent += '\n最终棋盘:\n';
                        logContent += formatBoard(finalBoard);
                    }

                    if (game.move_analysis && game.move_analysis.errors.length > 0) {
                        logContent += '\n错误汇总:\n';
                        game.move_analysis.errors.forEach(error => {
                            logContent += `- 第${error.move_number}步: ${error.type} (玩家${error.player}) - ${error.error}\n`;
                        });
                    }
                }

                logContent += '\n' + '='.repeat(80) + '\n\n';
            }
        }

        logContent += '比赛整体统计\n';
        logContent += '-'.repeat(40) + '\n';
        if (result.games && result.games.length > 0) {
            const totalDuration = result.games.reduce((sum, game) => sum + game.duration, 0);
            const avgGameDuration = totalDuration / result.games.length;

            logContent += `总比赛时长: ${totalDuration.toFixed(2)} 秒\n`;
            logContent += `平均每局时长: ${avgGameDuration.toFixed(2)} 秒\n`;

            const results = { wins: { 1: 0, 2: 0 }, timeouts: 0, errors: 0, exceptions: 0 };
            result.games.forEach(game => {
                if (game.move_analysis) {
                    results.timeouts += game.move_analysis.timeouts;
                    results.errors += game.move_analysis.invalid_moves;
                    results.exceptions += game.move_analysis.exceptions;
                }
            });

            if (results.timeouts > 0) logContent += `总超时次数: ${results.timeouts}\n`;
            if (results.errors > 0) logContent += `总无效移动: ${results.errors}\n`;
            if (results.exceptions > 0) logContent += `总异常次数: ${results.exceptions}\n`;
        }

        logContent += '\n' + '='.repeat(80) + '\n';
        logContent += '记录生成完毕\n';

        await fs.writeFile(logPath, logContent, 'utf8');
        Logger.success(`比赛详细记录已保存到: ${logPath}`);

        return logPath;
    } catch (error) {
        Logger.error('记录比赛详细信息失败:', error);
    }
}

function getWinnerDisplayName(winner, challengerSubmissionId, defenderSubmissionId) {
    if (winner === 'challenger') return `挑战者 (${challengerSubmissionId})`;
    if (winner === 'defender') return `防守者 (${defenderSubmissionId || 'default'})`;
    if (winner === 'tie') return '平局';
    return winner || '未知';
}

function getGameWinnerDisplayName(winner, challengerSubmissionId, defenderSubmissionId) {
    if (winner === 1) return `玩家1 (挑战者 ${challengerSubmissionId})`;
    if (winner === 2) return `玩家2 (防守者 ${defenderSubmissionId || 'default'})`;
    if (winner === 0) return '平局';
    return `玩家${winner}`;
}

function getStatusDisplayName(result) {
    switch (result) {
        case 'valid': return '有效移动';
        case 'winning_move': return '制胜一步';
        case 'draw_move': return '平局落子';
        case 'invalid_move': return '无效移动';
        case 'invalid_position': return '位置无效';
        case 'timeout': return '超时';
        case 'exception': return '异常';
        default: return result || '未知';
    }
}

function formatBoard(board) {
    if (!board || !Array.isArray(board)) return '棋盘数据无效\n';

    let boardStr = '';
    const size = board.length;

    boardStr += '   ';
    for (let j = 0; j < size; j++) {
        boardStr += String(j).padStart(2);
    }
    boardStr += '\n';

    for (let i = 0; i < size; i++) {
        boardStr += String(i).padStart(2) + ' ';
        for (let j = 0; j < size; j++) {
            const cell = board[i][j];
            if (cell === 0) {
                boardStr += ' .';
            } else if (cell === 1) {
                boardStr += ' ●';
            } else if (cell === 2) {
                boardStr += ' ○';
            } else {
                boardStr += ' ?';
            }
        }
        boardStr += '\n';
    }

    return boardStr;
}

function analyzeMovePatterns(moves) {
    const analysis = {
        total_moves: moves.length,
        valid_moves: 0,
        invalid_moves: 0,
        timeouts: 0,
        exceptions: 0,
        player_move_counts: { 1: 0, 2: 0 },
        average_times: { 1: 0, 2: 0 },
        move_time_distribution: { 1: [], 2: [] },
        errors: []
    };

    const playerTimes = { 1: [], 2: [] };

    moves.forEach((move, index) => {
        const player = move.player;

        switch (move.result) {
            case 'valid':
            case 'winning_move':
            case 'draw_move':
                analysis.valid_moves++;
                analysis.player_move_counts[player]++;
                playerTimes[player].push(move.time_taken);
                break;
            case 'invalid_move':
            case 'invalid_position':
                analysis.invalid_moves++;
                analysis.errors.push({
                    move_number: move.move_number,
                    player: player,
                    error: move.error,
                    type: 'invalid_move'
                });
                break;
            case 'timeout':
                analysis.timeouts++;
                analysis.errors.push({
                    move_number: move.move_number,
                    player: player,
                    error: move.error,
                    type: 'timeout'
                });
                break;
            case 'exception':
                analysis.exceptions++;
                analysis.errors.push({
                    move_number: move.move_number,
                    player: player,
                    error: move.error,
                    type: 'exception'
                });
                break;
        }
    });

    for (let player of [1, 2]) {
        if (playerTimes[player].length > 0) {
            analysis.average_times[player] = playerTimes[player].reduce((a, b) => a + b, 0) / playerTimes[player].length;
            analysis.move_time_distribution[player] = {
                min: Math.min(...playerTimes[player]),
                max: Math.max(...playerTimes[player]),
                median: playerTimes[player].sort((a, b) => a - b)[Math.floor(playerTimes[player].length / 2)]
            };
        }
    }

    return analysis;
}

async function calculatePlayerStats(submissionId) {
    const matches = await readJsonFile('./data/matches.json');
    let wins = 0;
    let losses = 0;

    matches.matches.forEach(match => {
        // 支持新的提交ID格式和旧的学生ID格式
        const challengerId = match.challenger_submission_id || match.challenger;
        const defenderId = match.defender_submission_id || match.defender;
        const winner = match.winner;

        if (challengerId === submissionId || defenderId === submissionId) {
            if (winner === submissionId) {
                wins++;
            } else if (winner !== 'tie') {
                losses++;
            }
        }
    });

    const totalGames = wins + losses;
    const winRate = totalGames > 0 ? wins / totalGames : 0;

    return { wins, losses, winRate };
}

async function updateRankings(submissionId, newRank) {
    const rankings = await readJsonFile('./data/rankings.json');
    const submission = await getSubmissionById(submissionId);

    if (!submission) {
        throw new Error(`找不到提交ID: ${submissionId}`);
    }

    const studentId = submission.student_id;

    // 查找该学生的现有排名
    const existingRankingIndex = rankings.rankings.findIndex(r => r.student_id === studentId);

    if (existingRankingIndex !== -1) {
        const existingRank = rankings.rankings[existingRankingIndex].rank;

        // 如果新排名不如现有排名（数字更大），则不更新排行榜
        if (newRank >= existingRank) {
            Logger.info(`学生 ${studentId} 的新提交 ${submissionId} 排名第 ${newRank} 名，不如现有排名第 ${existingRank} 名，不更新排行榜`);
            return;
        }

        // 移除该学生的旧排名记录
        rankings.rankings.splice(existingRankingIndex, 1);
        Logger.info(`学生 ${studentId} 的新提交 ${submissionId} 排名第 ${newRank} 名，优于现有排名第 ${existingRank} 名，更新排行榜`);
    } else {
        Logger.info(`学生 ${studentId} 的提交 ${submissionId} 首次进入排行榜，排名第 ${newRank} 名`);
    }

    // 更新其他排名（为新排名腾出位置）
    rankings.rankings.forEach(r => {
        if (r.rank >= newRank) {
            r.rank++;
        }
    });

    const stats = await calculatePlayerStats(submissionId);

    // 添加新排名
    rankings.rankings.push({
        rank: newRank,
        submission_id: submissionId,
        student_id: studentId,
        wins: stats.wins,
        losses: stats.losses,
        win_rate: stats.winRate,
        last_updated: new Date().toISOString()
    });

    // 重新排序并更新所有排名
    rankings.rankings.sort((a, b) => a.rank - b.rank);

    for (let i = 0; i < rankings.rankings.length; i++) {
        const player = rankings.rankings[i];
        const playerStats = await calculatePlayerStats(player.submission_id);
        player.rank = i + 1;
        player.wins = playerStats.wins;
        player.losses = playerStats.losses;
        player.win_rate = playerStats.winRate;
        player.last_updated = new Date().toISOString();
    }

    await writeJsonFile('./data/rankings.json', rankings);
} app.use(async (error, req, res, next) => {
    const context = `HTTP ${req.method} ${req.url} - IP: ${req.ip}`;
    await logError(error, context);

    if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: '文件大小超过50KB限制' });
    }

    res.status(500).json({ error: error.message || '服务器内部错误' });
});

async function startServer() {
    try {
        await ensureLogDirectory();
        await initializeDataFiles();

        app.listen(PORT, () => {
            Logger.server(`五子棋对战平台已启动在端口 ${PORT}`);
            Logger.server(`访问 http://localhost:${PORT} 开始使用`);
            Logger.info(`日志文件保存在 ./logs 目录下`);
        });
    } catch (error) {
        await logError(error, '启动服务器失败');
        Logger.error('启动服务器失败:', error);
        process.exit(1);
    }
}

process.on('uncaughtException', async (error) => {
    await logError(error, '未捕获的异常');
    Logger.error('未捕获的异常:', error);
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    await logError(error, `未处理的Promise拒绝 - Promise: ${promise}`);
    Logger.error('未处理的Promise拒绝:', reason);
});

startServer();

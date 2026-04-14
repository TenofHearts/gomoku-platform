const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const writeFileAtomic = require('write-file-atomic');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { spawn } = require('child_process');
const chalk = require('chalk');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_PROCESS_OUTPUT_CHARS = 1024 * 1024;
const MATCH_TIMEOUT_MS = Number(process.env.MATCH_TIMEOUT_MS || 6000 * 1000);
const MATCH_GAMES = 5;
const MATCH_WORKERS = 5;
const MAX_RANKINGS = 10;
const PYTHON_EXECUTABLE = process.env.PYTHON_EXECUTABLE || 'python';
const RESULT_JSON_BEGIN = '__GOMOKU_MATCH_RESULT_JSON_BEGIN__';
const RESULT_JSON_END = '__GOMOKU_MATCH_RESULT_JSON_END__';

function appendBoundedOutput(current, chunk, limit = MAX_PROCESS_OUTPUT_CHARS) {
    if (current.length >= limit) {
        return current;
    }

    const next = current + chunk.toString();
    if (next.length <= limit) {
        return next;
    }

    return next.slice(0, limit) + '\n[output truncated]\n';
}

function parseMatchResult(stdout) {
    const beginIndex = stdout.lastIndexOf(RESULT_JSON_BEGIN);
    const endIndex = stdout.lastIndexOf(RESULT_JSON_END);

    if (beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
        const payloadStart = beginIndex + RESULT_JSON_BEGIN.length;
        return JSON.parse(stdout.slice(payloadStart, endIndex).trim());
    }

    try {
        return JSON.parse(stdout);
    } catch (error) {
        const firstBrace = stdout.indexOf('{');
        const lastBrace = stdout.lastIndexOf('}');

        if (firstBrace !== -1 && lastBrace > firstBrace) {
            return JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
        }

        throw error;
    }
}

function validatePythonSyntax(filePath) {
    return new Promise((resolve, reject) => {
        const validator = spawn(PYTHON_EXECUTABLE, [
            '-c',
            'import ast, pathlib, sys\nast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))',
            filePath
        ], {
            cwd: __dirname,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';
        const timer = setTimeout(() => {
            validator.kill('SIGKILL');
            reject(new Error('Python语法检查超时'));
        }, 5000);

        validator.stderr.on('data', (data) => {
            stderr = appendBoundedOutput(stderr, data, 64 * 1024);
        });

        validator.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });

        validator.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(stderr.trim() || 'Python语法检查失败'));
            }
        });
    });
}

function getObfuscatedSubmissionFilename(submissionId) {
    const digest = crypto.createHash('sha256').update(submissionId).digest('hex');
    return `agent_${digest}.py`;
}

class ChallengeQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.currentSubmissionId = null;
        this.hotReloadRestoredSubmissions = new Set();
    }

    async restoreFromSubmissionHistory() {
        try {
            const submissionHistory = await readJsonFile('./data/submission_history.json');
            const submissions = Array.isArray(submissionHistory.submissions) ? submissionHistory.submissions : [];
            const testingSubmissions = submissions
                .filter(submission => submission.status === 'testing')
                .sort((a, b) => new Date(a.upload_time) - new Date(b.upload_time));
            const waitingSubmissions = submissions
                .filter(submission => submission.status === 'waiting')
                .sort((a, b) => new Date(a.upload_time) - new Date(b.upload_time));
            const restoredTestingIds = testingSubmissions.map(submission => submission.submission_id);
            const waitingIds = waitingSubmissions.map(submission => submission.submission_id);

            this.queue = [...new Set([...restoredTestingIds, ...waitingIds])];
            this.hotReloadRestoredSubmissions = new Set(restoredTestingIds);
            this.currentSubmissionId = null;
            this.isProcessing = false;

            if (this.queue.length > 0) {
                Logger.info(`从现有提交记录恢复挑战队列，共 ${this.queue.length} 个待处理提交`);
                this.processNext();
            }
        } catch (error) {
            Logger.error('恢复挑战队列失败:', error);
            await logError(error, '恢复挑战队列失败');
        }
    }

    addChallenger(submissionId) {
        if (this.queue.includes(submissionId) || this.currentSubmissionId === submissionId) {
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
        const wasRestoredFromHotReload = this.hotReloadRestoredSubmissions.delete(currentChallengerSubmissionId);
        this.currentSubmissionId = currentChallengerSubmissionId;

        Logger.info(`开始处理挑战者: ${currentChallengerSubmissionId}，剩余队列长度: ${this.queue.length}`);

        try {
            await startChallengeProcess(currentChallengerSubmissionId, { wasRestoredFromHotReload });
            Logger.success(`挑战者 ${currentChallengerSubmissionId} 的所有对局已完成`);
        } catch (error) {
            Logger.error(`处理挑战者 ${currentChallengerSubmissionId} 时发生错误:`, error);
            await logError(error, `处理挑战者队列失败 - 挑战者: ${currentChallengerSubmissionId}`);
        }

        this.currentSubmissionId = null;
        this.isProcessing = false;

        if (this.queue.length > 0) {
            Logger.info(`继续处理队列中的下一个挑战者，剩余: ${this.queue.length} 个`);
            setTimeout(() => this.processNext(), 1000);
        } else {
            Logger.info('所有挑战者已处理完成，挑战队列为空');
        }
    }

    getStatus() {
        const queue = this.currentSubmissionId ? [this.currentSubmissionId, ...this.queue] : [...this.queue];
        return {
            queueLength: queue.length,
            isProcessing: this.isProcessing,
            currentSubmissionId: this.currentSubmissionId,
            queue
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

    clear() {
        const previousStatus = this.getStatus();
        this.queue = [];
        this.hotReloadRestoredSubmissions.clear();
        return previousStatus;
    }
}

const challengeQueue = new ChallengeQueue();

class FileWriteQueue {
    constructor() {
        this.queues = new Map();
        this.pendingUpdates = new Map();
        this.updateTimers = new Map();
        this.batchDelay = 100;
    }

    async writeFile(filePath, data) {
        if (!this.queues.has(filePath)) {
            this.queues.set(filePath, Promise.resolve());
        }

        const currentQueue = this.queues.get(filePath);
        const newQueue = currentQueue.then(async () => {
            try {
                Logger.debug(`开始写入文件: ${path.basename(filePath)}`);
                await writeFileAtomic(filePath, JSON.stringify(data, null, 2), 'utf8');
                Logger.debug(`文件写入完成: ${path.basename(filePath)}`);
            } catch (error) {
                Logger.error(`文件写入失败: ${path.basename(filePath)}`, error);
                throw error;
            }
        });

        this.queues.set(filePath, newQueue);
        return newQueue;
    }

    async batchWriteFile(filePath, data) {
        if (this.updateTimers.has(filePath)) {
            clearTimeout(this.updateTimers.get(filePath));
        }

        this.pendingUpdates.set(filePath, data);

        const timer = setTimeout(async () => {
            const pendingData = this.pendingUpdates.get(filePath);
            if (pendingData) {
                await this.writeFile(filePath, pendingData);
                this.pendingUpdates.delete(filePath);
                this.updateTimers.delete(filePath);
            }
        }, this.batchDelay);

        this.updateTimers.set(filePath, timer);

        return new Promise((resolve, reject) => {
            const checkCompletion = () => {
                if (!this.updateTimers.has(filePath)) {
                    const queue = this.queues.get(filePath);
                    if (queue) {
                        queue.then(resolve).catch(reject);
                    } else {
                        resolve();
                    }
                } else {
                    setTimeout(checkCompletion, 10);
                }
            };
            checkCompletion();
        });
    }

    async flushAll() {
        const flushPromises = [];

        for (const [filePath, timer] of this.updateTimers.entries()) {
            clearTimeout(timer);
            const pendingData = this.pendingUpdates.get(filePath);
            if (pendingData) {
                flushPromises.push(this.writeFile(filePath, pendingData));
                this.pendingUpdates.delete(filePath);
            }
            this.updateTimers.delete(filePath);
        }

        await Promise.all(flushPromises);
    }

    getQueueStatus() {
        const status = {};
        for (const [filePath, queue] of this.queues.entries()) {
            status[path.basename(filePath)] = {
                isPending: queue !== Promise.resolve(),
                hasPendingUpdate: this.pendingUpdates.has(filePath),
                hasTimer: this.updateTimers.has(filePath)
            };
        }
        return status;
    }
}

const fileWriteQueue = new FileWriteQueue();

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
        fs.mkdir('submissions', { recursive: true })
            .then(() => cb(null, 'submissions/'))
            .catch(cb);
    },
    filename: (req, file, cb) => {
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
        if (path.extname(file.originalname).toLowerCase() !== '.py') {
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
    await fileWriteQueue.writeFile(filePath, data);
}

async function batchWriteJsonFile(filePath, data) {
    await fileWriteQueue.batchWriteFile(filePath, data);
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

async function cancelQueuedSubmissions(submissionIds) {
    const queuedSubmissionIds = new Set(submissionIds);
    if (queuedSubmissionIds.size === 0) {
        return [];
    }

    const submissionHistory = await readJsonFile('./data/submission_history.json');
    const cancelledSubmissionIds = [];

    for (const submission of submissionHistory.submissions || []) {
        if (queuedSubmissionIds.has(submission.submission_id) && ['waiting', 'testing'].includes(submission.status)) {
            submission.status = 'cancelled';
            submission.status_updated = new Date().toISOString();
            cancelledSubmissionIds.push(submission.submission_id);
        }
    }

    if (cancelledSubmissionIds.length > 0) {
        await writeJsonFile('./data/submission_history.json', submissionHistory);
    }

    return cancelledSubmissionIds;
}

function requireAuth(req, res, next) {
    if (!req.session.studentId) {
        return res.status(401).json({ error: '请先登录' });
    }
    next();
}

async function initializeDataFiles() {
    await fs.mkdir('./data', { recursive: true });
    await fs.mkdir('./submissions', { recursive: true });

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

        try {
            await validatePythonSyntax(filePath);
        } catch (error) {
            await fs.unlink(filePath);
            return res.status(400).json({ error: `Python语法检查失败: ${error.message}` });
        }

        const submissionHistory = await readJsonFile('./data/submission_history.json');
        submissionHistory.counter = (submissionHistory.counter || 0) + 1;
        const submissionId = `SUB${submissionHistory.counter.toString().padStart(6, '0')}`;

        const newFileName = getObfuscatedSubmissionFilename(submissionId);
        const newFilePath = path.join('submissions', newFileName);
        await fs.rename(filePath, newFilePath);

        const newSubmission = {
            submission_id: submissionId,
            student_id: studentId,
            filename: newFileName,
            original_filename: req.file.originalname,
            file_path: newFilePath,
            upload_time: new Date().toISOString(),
            status: 'waiting',
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
        rankings.rankings.sort((a, b) => a.rank - b.rank);
        rankings.rankings = rankings.rankings.slice(0, MAX_RANKINGS);

        for (let i = 0; i < rankings.rankings.length; i++) {
            const player = rankings.rankings[i];
            player.rank = i + 1;

            if (!player.submission_id && player.student_id) {
                const studentSubmissions = await getSubmissionsByStudentId(player.student_id);
                if (studentSubmissions.length > 0) {
                    player.submission_id = studentSubmissions[0].submission_id;
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

        const studentSubmissions = await getSubmissionsByStudentId(studentId);
        const submissionIds = studentSubmissions.map(sub => sub.submission_id);

        const myMatches = matches.matches.filter(match => {
            const challengerId = match.challenger_submission_id || match.challenger;
            const defenderId = match.defender_submission_id || match.defender;

            return challengerId === studentId || defenderId === studentId ||
                submissionIds.includes(challengerId) || submissionIds.includes(defenderId);
        });

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
        const fileQueueStatus = fileWriteQueue.getQueueStatus();
        res.json({
            success: true,
            challengeQueue: queueStatus,
            fileWriteQueue: fileQueueStatus
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

        const studentSubmissions = await getSubmissionsByStudentId(studentId);
        const submissionIds = studentSubmissions.map(sub => sub.submission_id);

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

app.get('/api/my-submissions', requireAuth, async (req, res) => {
    try {
        const studentId = req.session.studentId;
        const submissions = await getSubmissionsByStudentId(studentId);

        for (let submission of submissions) {
            const stats = await calculatePlayerStats(submission.submission_id);
            submission.stats = stats;

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

app.get('/api/submission/:submissionId', requireAuth, async (req, res) => {
    try {
        const submissionId = req.params.submissionId;
        const studentId = req.session.studentId;

        const submission = await getSubmissionById(submissionId);
        if (!submission) {
            return res.status(404).json({ error: '提交不存在' });
        }

        if (submission.student_id !== studentId) {
            return res.status(403).json({ error: '无权限访问该提交' });
        }

        const stats = await calculatePlayerStats(submissionId);
        submission.stats = stats;

        const rankings = await readJsonFile('./data/rankings.json');
        const ranking = rankings.rankings.find(r => r.submission_id === submissionId);
        submission.current_rank = ranking ? ranking.rank : null;

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

app.get('/api/download/:submissionId', requireAuth, async (req, res) => {
    try {
        const submissionId = req.params.submissionId;
        const studentId = req.session.studentId;

        const submission = await getSubmissionById(submissionId);
        if (!submission) {
            return res.status(404).json({ error: '提交不存在' });
        }

        if (submission.student_id !== studentId) {
            return res.status(403).json({ error: '无权限下载该提交' });
        }

        try {
            await fs.access(submission.file_path);
        } catch {
            return res.status(404).json({ error: '文件不存在' });
        }

        const fileContent = await fs.readFile(submission.file_path, 'utf8');
        const downloadName = path.basename(submission.original_filename || submission.filename).replace(/[\r\n"]/g, '_');

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
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

        const oldStatus = challengeQueue.clear();
        const queuedSubmissionIds = oldStatus.queue.filter(submissionId => submissionId !== oldStatus.currentSubmissionId);
        const cancelledSubmissions = await cancelQueuedSubmissions(queuedSubmissionIds);

        Logger.warn('管理员清理了挑战队列', {
            ...oldStatus,
            cancelledSubmissions
        });

        res.json({
            success: true,
            message: '挑战队列已清理',
            previousStatus: oldStatus,
            cancelledSubmissions
        });
    } catch (error) {
        await logError(error, '清理挑战队列失败');
        res.status(500).json({ error: '服务器内部错误' });
    }
});

async function startChallengeProcess(challengerSubmissionId, options = {}) {
    try {
        Logger.info(`========== 开始处理挑战者提交 ${challengerSubmissionId} ==========`);

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
        if (options.wasRestoredFromHotReload && existingRank) {
            targetRank = existingRank.rank - 1;
            Logger.info(`热更新恢复提交 ${challengerSubmissionId}，当前排行榜第 ${existingRank.rank} 名，将从第 ${targetRank} 名继续挑战`);
        } else if (rankings.rankings.length < 10) {
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

        await updateSubmissionStatus(challengerSubmissionId, 'completed');
    } catch (error) {
        await updateSubmissionStatus(challengerSubmissionId, 'error');
        await logError(error, `打擂台挑战失败 - 挑战者提交: ${challengerSubmissionId}`);
        Logger.error(`打擂台挑战失败:`, error);
        throw error;
    }
}

async function runMatch(challengerSubmissionId, defenderSubmissionId) {
    return new Promise(async (resolve, reject) => {
        let matchResultPath = null;
        try {
            const challengerSubmission = await getSubmissionById(challengerSubmissionId);
            const defenderSubmission = defenderSubmissionId ? await getSubmissionById(defenderSubmissionId) : null;

            if (!challengerSubmission) {
                throw new Error(`找不到挑战者提交: ${challengerSubmissionId}`);
            }

            const challengerPath = challengerSubmission.file_path;
            const defenderPath = defenderSubmission ? defenderSubmission.file_path : './gomoku/agent.py';

            Logger.match(`开始比赛: ${challengerSubmissionId} vs ${defenderSubmissionId || 'default'}`);
            await ensureLogDirectory();
            const resultFileName = `match_result_${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2)}.json`;
            matchResultPath = path.join(__dirname, 'logs', resultFileName);

            const pythonProcess = spawn(PYTHON_EXECUTABLE, [
                './match.py',
                '--challenger', challengerPath,
                '--defender', defenderPath,
                '--games', String(MATCH_GAMES),
                '--workers', String(MATCH_WORKERS),
                '--silent',
                '--output', matchResultPath
            ], {
                cwd: __dirname,
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';
            let timedOut = false;

            const matchTimer = setTimeout(() => {
                timedOut = true;
                Logger.warn(`比赛进程超时，准备终止: ${challengerSubmissionId} vs ${defenderSubmissionId || 'default'}`);
                pythonProcess.kill('SIGKILL');
            }, MATCH_TIMEOUT_MS);

            pythonProcess.stdout.on('data', (data) => {
                stdout = appendBoundedOutput(stdout, data);
            });

            pythonProcess.stderr.on('data', (data) => {
                stderr = appendBoundedOutput(stderr, data);
            });

            pythonProcess.on('close', async (code) => {
                clearTimeout(matchTimer);
                try {
                    if (timedOut) {
                        const timeoutSeconds = Math.round(MATCH_TIMEOUT_MS / 1000);
                        const errorMsg = `比赛进程超时，已终止，限制: ${timeoutSeconds}秒`;
                        Logger.error(errorMsg);
                        await logError(new Error(errorMsg), `比赛超时 - ${challengerSubmissionId} vs ${defenderSubmissionId || 'default'} - stdout=${stdout}, stderr=${stderr}`);
                        if (matchResultPath) {
                            fs.unlink(matchResultPath).catch(() => {});
                            matchResultPath = null;
                        }

                        resolve({
                            winner: defenderSubmissionId || 'default',
                            challenger_wins: 0,
                            defender_wins: MATCH_GAMES,
                            error: errorMsg
                        });
                        return;
                    }

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
                        if (matchResultPath) {
                            fs.unlink(matchResultPath).catch(() => {});
                            matchResultPath = null;
                        }

                        resolve({
                            winner: defenderSubmissionId || 'default',
                            challenger_wins: 0,
                            defender_wins: MATCH_GAMES,
                            error: `比赛进程异常: ${stderr}`
                        });
                        return;
                    }

                    const resultOutput = await fs.readFile(matchResultPath, 'utf8');
                    const result = JSON.parse(resultOutput);
                    fs.unlink(matchResultPath).catch(() => {});
                    matchResultPath = null;

                    await recordMatch(challengerSubmissionId, defenderSubmissionId, result);

                    resolve(result);
                } catch (error) {
                    const errorMsg = `处理比赛结果失败: ${error.message}`;
                    Logger.error(errorMsg);
                    Logger.debug(`比赛结果处理错误详细信息:`);
                    Logger.debug(`- 挑战者: ${challengerSubmissionId}`);
                    Logger.debug(`- 防守者: ${defenderSubmissionId || 'default'}`);
                    Logger.debug(`- 标准输出长度: ${stdout.length}`);
                    Logger.debug(`- 标准输出内容: ${stdout.substring(0, 1000)}${stdout.length > 1000 ? '...(截断)' : ''}`);
                    Logger.debug(`- 结果文件: ${matchResultPath || '(已清理)'}`);
                    Logger.debug(`- 错误输出: ${stderr || '(无错误输出)'}`);
                    Logger.debug(`- 处理错误: ${error.stack}`);

                    await logError(error, `处理比赛结果失败 - ${challengerSubmissionId} vs ${defenderSubmissionId || 'default'} - stdout长度=${stdout.length}, stderr=${stderr}, 原始输出=${stdout}`);
                    if (matchResultPath) {
                        fs.unlink(matchResultPath).catch(() => {});
                        matchResultPath = null;
                    }

                    resolve({
                        winner: defenderSubmissionId || 'default',
                        challenger_wins: 0,
                        defender_wins: MATCH_GAMES,
                        error: '解析结果失败'
                    });
                }
            });

            pythonProcess.on('error', async (error) => {
                clearTimeout(matchTimer);
                Logger.error('启动比赛进程失败:', error.message);
                Logger.debug(`进程启动错误详细信息:`);
                Logger.debug(`- 错误类型: ${error.name}`);
                Logger.debug(`- 错误代码: ${error.code || '未知'}`);
                Logger.debug(`- 错误信号: ${error.signal || '未知'}`);
                Logger.debug(`- 完整错误: ${error.stack}`);
                Logger.debug(`- 挑战者路径: ${challengerPath}`);
                Logger.debug(`- 防守者路径: ${defenderPath}`);

                await logError(error, `启动比赛进程失败 - ${challengerSubmissionId} vs ${defenderSubmissionId || 'default'} - 错误代码=${error.code}, 信号=${error.signal}`);
                if (matchResultPath) {
                    fs.unlink(matchResultPath).catch(() => {});
                    matchResultPath = null;
                }

                resolve({
                    winner: defenderSubmissionId || 'default',
                    challenger_wins: 0,
                    defender_wins: MATCH_GAMES,
                    error: '启动进程失败'
                });
            });
        } catch (error) {
            Logger.error('比赛执行前准备失败:', error);
            await logError(error, `比赛准备失败 - ${challengerSubmissionId} vs ${defenderSubmissionId || 'default'}`);
            if (matchResultPath) {
                fs.unlink(matchResultPath).catch(() => {});
            }
            resolve({
                winner: defenderSubmissionId || 'default',
                challenger_wins: 0,
                defender_wins: MATCH_GAMES,
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

    const detailedGames = (result.games || []).map((game) => {
        const gameRecord = game.game_record || {};
        const moves = Array.isArray(gameRecord.moves) ? gameRecord.moves : [];
        const skillCasts = Array.isArray(gameRecord.skill_casts) ? gameRecord.skill_casts : [];

        return {
            game_number: game.game,
            winner: game.winner,
            duration: game.duration,
            challenger_first: game.challenger_first,
            move_analysis: analyzeMovePatterns(moves),
            game_record: {
                board_size: gameRecord.board_size || 15,
                total_moves: gameRecord.total_moves || 0,
                average_move_time: gameRecord.average_move_time || 0,
                player_statistics: gameRecord.player_statistics || {
                    1: { moves: 0, total_time: 0, average_time: 0 },
                    2: { moves: 0, total_time: 0, average_time: 0 }
                },
                skill_casts: skillCasts,
                moves
            }
        };
    });

    const skillSummary = detailedGames.reduce((summary, game) => {
        const casts = game.game_record?.skill_casts || [];
        summary.total_cast += casts.length;
        return summary;
    }, { total_cast: 0 });

    const matchRecord = {
        id: `match_${Date.now()}`,
        challenger_submission_id: challengerSubmissionId,
        challenger_student_id: challengerSubmission.student_id,
        defender_submission_id: defenderSubmissionId || 'default',
        defender_student_id: defenderSubmission ? defenderSubmission.student_id : 'default',
        winner: actualWinner,
        games_played: result.total_games || result.games?.length || MATCH_GAMES,
        challenger_wins: result.challenger_wins,
        defender_wins: result.defender_wins,
        timestamp: new Date().toISOString(),
        total_duration: result.games ? result.games.reduce((sum, game) => sum + game.duration, 0) : 0,
        average_game_duration: result.games && result.games.length > 0 ? result.games.reduce((sum, game) => sum + game.duration, 0) / result.games.length : 0,
        games: detailedGames,
        skill_summary: skillSummary
    };

    matches.matches.push(matchRecord);
    await batchWriteJsonFile('./data/matches.json', matches);

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

                    if (game.game_record.skill_casts && game.game_record.skill_casts.length > 0) {
                        logContent += '\n技能释放记录:\n';
                        game.game_record.skill_casts.forEach((cast) => {
                            logContent += `- 玩家${cast.player} 在第${cast.move_number}手释放技能，位置(${cast.position[0]}, ${cast.position[1]})\n`;
                        });
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

                    const finalBoard = reconstructBoardState(moves, game.game_record.skill_casts, boardSize);
                    if (finalBoard) {
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
        case 'blocked_position': return '封锁位落子';
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
            } else if (cell === 3) {
                boardStr += ' ◇';
            } else if (cell === 4) {
                boardStr += ' ◆';
            } else {
                boardStr += ' ?';
            }
        }
        boardStr += '\n';
    }

    return boardStr;
}

function createEmptyBoard(boardSize) {
    return Array.from({ length: boardSize }, () => Array(boardSize).fill(0));
}

function isStoneCell(cellValue) {
    return cellValue === 1 || cellValue === 2;
}

function isValidBoardPosition(board, row, col) {
    return Number.isInteger(row)
        && Number.isInteger(col)
        && row >= 0
        && col >= 0
        && row < board.length
        && col < board.length;
}

function getSkillMarker(player) {
    return player === 1 ? 3 : 4;
}

function clearBlockedCell(board, blockedCellForPlayer, player) {
    const blockedCell = blockedCellForPlayer[player];
    if (!blockedCell) {
        return;
    }

    const [row, col] = blockedCell;
    const caster = 3 - player;
    const expectedMarker = getSkillMarker(caster);

    if (isValidBoardPosition(board, row, col) && board[row][col] === expectedMarker) {
        board[row][col] = 0;
    }

    blockedCellForPlayer[player] = null;
}

function reconstructBoardState(moves, skillCasts, boardSize) {
    if (!Number.isInteger(boardSize) || boardSize <= 0) {
        return null;
    }

    const board = createEmptyBoard(boardSize);
    const blockedCellForPlayer = { 1: null, 2: null };
    const skillCastByMoveNumber = new Map();

    for (const cast of Array.isArray(skillCasts) ? skillCasts : []) {
        if (cast && Number.isInteger(cast.move_number)) {
            skillCastByMoveNumber.set(cast.move_number, cast);
        }
    }

    for (const move of Array.isArray(moves) ? moves : []) {
        if (!move || !Number.isInteger(move.player) || !Number.isInteger(move.move_number)) {
            continue;
        }

        const skillCast = skillCastByMoveNumber.get(move.move_number);
        if (skillCast && skillCast.player === move.player && Array.isArray(skillCast.position) && skillCast.position.length === 2) {
            const [skillRow, skillCol] = skillCast.position;
            if (isValidBoardPosition(board, skillRow, skillCol) && !isStoneCell(board[skillRow][skillCol])) {
                blockedCellForPlayer[3 - move.player] = [skillRow, skillCol];
                board[skillRow][skillCol] = getSkillMarker(move.player);
            }
        }

        const isSuccessfulMove = move.result === 'valid' || move.result === 'winning_move' || move.result === 'draw_move';
        if (isSuccessfulMove && Array.isArray(move.move) && move.move.length === 2) {
            const [row, col] = move.move;
            if (isValidBoardPosition(board, row, col)) {
                board[row][col] = move.player;
            }

            if (move.result === 'valid') {
                clearBlockedCell(board, blockedCellForPlayer, move.player);
            }
        }
    }

    return board;
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
            case 'blocked_position':
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

    const existingRankingIndex = rankings.rankings.findIndex(r => r.student_id === studentId);

    if (existingRankingIndex !== -1) {
        const existingRank = rankings.rankings[existingRankingIndex].rank;

        if (newRank >= existingRank) {
            Logger.info(`学生 ${studentId} 的新提交 ${submissionId} 排名第 ${newRank} 名，不如现有排名第 ${existingRank} 名，不更新排行榜`);
            return;
        }

        rankings.rankings.splice(existingRankingIndex, 1);
        Logger.info(`学生 ${studentId} 的新提交 ${submissionId} 排名第 ${newRank} 名，优于现有排名第 ${existingRank} 名，更新排行榜`);
    } else {
        Logger.info(`学生 ${studentId} 的提交 ${submissionId} 首次进入排行榜，排名第 ${newRank} 名`);
    }

    rankings.rankings.forEach(r => {
        if (r.rank >= newRank) {
            r.rank++;
        }
    });

    const stats = await calculatePlayerStats(submissionId);

    rankings.rankings.push({
        rank: newRank,
        submission_id: submissionId,
        student_id: studentId,
        wins: stats.wins,
        losses: stats.losses,
        win_rate: stats.winRate,
        last_updated: new Date().toISOString()
    });

    rankings.rankings.sort((a, b) => a.rank - b.rank);
    rankings.rankings = rankings.rankings.slice(0, MAX_RANKINGS);

    for (let i = 0; i < rankings.rankings.length; i++) {
        const player = rankings.rankings[i];
        const playerStats = await calculatePlayerStats(player.submission_id);
        player.rank = i + 1;
        player.wins = playerStats.wins;
        player.losses = playerStats.losses;
        player.win_rate = playerStats.winRate;
        player.last_updated = new Date().toISOString();
    }

    await batchWriteJsonFile('./data/rankings.json', rankings);
}

app.use(async (error, req, res, next) => {
    const context = `HTTP ${req.method} ${req.url} - IP: ${req.ip}`;
    await logError(error, context);

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: '文件大小超过50KB限制' });
    }

    if (error.message === '只允许上传Python文件') {
        return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: '服务器内部错误' });
});

async function startServer() {
    try {
        await ensureLogDirectory();
        await initializeDataFiles();
        await challengeQueue.restoreFromSubmissionHistory();

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
    await gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', async (reason, promise) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    await logError(error, `未处理的Promise拒绝 - Promise: ${promise}`);
    Logger.error('未处理的Promise拒绝:', reason);
});

async function gracefulShutdown(signal) {
    Logger.warn(`收到 ${signal} 信号，开始优雅关闭...`);

    try {
        Logger.info('正在刷新所有待处理的文件写入...');
        await fileWriteQueue.flushAll();
        Logger.success('所有待处理的文件写入已完成');

        if (challengeQueue.isProcessing) {
            Logger.info('等待当前挑战处理完成...');
            let waitTime = 0;
            const maxWaitTime = 30000;

            while (challengeQueue.isProcessing && waitTime < maxWaitTime) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                waitTime += 1000;
                Logger.debug(`等待挑战完成: ${waitTime}ms`);
            }

            if (challengeQueue.isProcessing) {
                Logger.warn('挑战处理超时，强制退出');
            } else {
                Logger.success('挑战处理已完成');
            }
        }

        Logger.info('正在刷新挑战完成后的待处理文件写入...');
        await fileWriteQueue.flushAll();
        Logger.success('最终文件写入刷新完成');

        Logger.success('优雅关闭完成');
        process.exit(0);
    } catch (error) {
        Logger.error('优雅关闭过程中出错:', error);
        process.exit(1);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

if (process.env.GOMOKU_HOT_RELOAD_CHILD === '1') {
    process.on('message', message => {
        if (message && message.type === 'gomoku:shutdown') {
            gracefulShutdown(message.reason || 'hot-reload');
        }
    });
}

startServer();

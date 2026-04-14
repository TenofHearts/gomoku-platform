const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const watchFiles = [
    'server.js',
    'package.json'
];

let child = null;
let restartTimer = null;
let restartRequested = false;
let shuttingDown = false;

function startServer() {
    restartRequested = false;
    child = spawn(process.execPath, ['server.js'], {
        cwd: rootDir,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, GOMOKU_HOT_RELOAD_CHILD: '1' }
    });

    child.on('exit', (code, signal) => {
        child = null;

        if (shuttingDown) {
            process.exit(code ?? (signal ? 1 : 0));
        }

        if (restartRequested) {
            startServer();
            return;
        }

        console.log(`[hot-reload] server exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
        process.exit(code ?? 1);
    });
}

function requestChildShutdown(reason, fallbackSignal = 'SIGTERM') {
    if (!child) {
        return;
    }

    if (child.connected) {
        child.send({ type: 'gomoku:shutdown', reason }, error => {
            if (error && child) {
                child.kill(fallbackSignal);
            }
        });
        return;
    }

    child.kill(fallbackSignal);
}

function requestRestart(filePath) {
    if (shuttingDown) {
        return;
    }

    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
        console.log(`[hot-reload] change detected in ${filePath}; restarting server`);
        restartRequested = true;

        if (child) {
            requestChildShutdown('hot-reload');
        } else {
            startServer();
        }
    }, 300);
}

function watchFile(relativePath) {
    const filePath = path.join(rootDir, relativePath);
    fs.watchFile(filePath, { interval: 1000 }, (current, previous) => {
        if (current.mtimeMs !== previous.mtimeMs) {
            requestRestart(relativePath);
        }
    });
}

function shutdown(signal) {
    shuttingDown = true;
    clearTimeout(restartTimer);

    for (const relativePath of watchFiles) {
        fs.unwatchFile(path.join(rootDir, relativePath));
    }

    if (child) {
        requestChildShutdown(signal, signal);
    } else {
        process.exit(0);
    }
}

for (const relativePath of watchFiles) {
    watchFile(relativePath);
}

startServer();

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

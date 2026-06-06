/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, app, dialog, shell } from 'electron';
import log from 'electron-log';

export const logger = log.scope('main');
log.initialize();

log.transports.file.level =
  process.env.NODE_ENV === 'development' ? 'debug' : 'info';
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
log.transports.file.archiveLogFn = (file) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const newPath = `${file.path}.${timestamp}`;
  fs.renameSync(file.path, newPath);
};

const MAX_LOG_FILES = 5;

export function getLogFilePath() {
  return log.transports.file.getFile().path;
}

export function getLogDir() {
  return path.dirname(getLogFilePath());
}

export async function revealLogFile() {
  const filePath = getLogFilePath();
  return await shell.openPath(filePath);
}

export async function revealLogDir() {
  return await shell.openPath(getLogDir());
}

export function clearLogs() {
  try {
    const logFile = log.transports.file.getFile();
    logFile.clear();
    logger.info('log file cleared');
    return true;
  } catch (error) {
    logger.error('clear log file failed:', error);
    return false;
  }
}

export function getHistoryLogs() {
  const logDir = getLogDir();
  const files = fs
    .readdirSync(logDir)
    .filter((file) => file.startsWith('main.log.'))
    .sort((a, b) => {
      const statA = fs.statSync(path.join(logDir, a));
      const statB = fs.statSync(path.join(logDir, b));
      return statB.mtime.getTime() - statA.mtime.getTime();
    });
  return files.map((file) => path.join(logDir, file));
}

export async function cleanupOldLogs() {
  const logFiles = getHistoryLogs();
  if (logFiles.length > MAX_LOG_FILES) {
    const filesToDelete = logFiles.slice(MAX_LOG_FILES);
    for (const file of filesToDelete) {
      try {
        fs.unlinkSync(file);
        logger.info(`Deleted old log file: ${file}`);
      } catch (error) {
        logger.error(`Failed to delete old log file ${file}:`, error);
      }
    }
  }
}

export async function exportLogs() {
  try {
    const browserWindow =
      BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!browserWindow) {
      logger.error('No browser window found');
      return false;
    }

    const logFile = log.transports.file.getFile();
    const defaultPath = `ui-tars-logs-${Date.now()}.log`;

    const { filePath } = await dialog.showSaveDialog(browserWindow!, {
      title: 'Export Logs',
      defaultPath: defaultPath,
      filters: [{ name: 'Logs', extensions: ['log'] }],
    });

    if (!filePath) {
      logger.info('User canceled log export');
      return false;
    }

    await fs.promises.copyFile(logFile.path, filePath);
    logger.info(`Logs exported to: ${filePath}`);
    return true;
  } catch (error) {
    logger.error('Export logs failed:', error);
    return false;
  }
}

app.on('before-quit', () => {
  // Remove the clearLogs call from app.on('before-quit')
  // clearLogs();
  log.transports.console.level = false;
});

// Call cleanupOldLogs() when the app starts
cleanupOldLogs().catch((error) => {
  logger.error('Failed to cleanup logs on startup:', error);
});

// Override console transport to filter and format clean output
if (log.transports.console) {
  const originalWrite = log.transports.console.writeFn;
  log.transports.console.writeFn = (options) => {
    const { message } = options;
    const dataStrs = message.data.map((item) => {
      if (typeof item === 'object' && item !== null) {
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      }
      return String(item);
    });
    const fullText = dataStrs.join(' ');

    // 1. Explicitly allow existing [Hi-Bee Live] logs
    if (fullText.includes('[Hi-Bee Live]')) {
      originalWrite(options);
      return;
    }

    // 2. Intercept and format key user voice & agent run actions
    if (fullText.includes('[useCloudSTT] Transcription result')) {
      const transcript = fullText.match(/Transcription result.*:\s*"([^"]+)"/)?.[1] || 
                         fullText.match(/"([^"]+)"/)?.[1] || '';
      if (transcript) {
        originalWrite({
          ...options,
          message: {
            ...message,
            data: [`\x1b[35m[Hi-Bee Live] 🎙️ User Said: "${transcript}"\x1b[0m`],
          },
        });
      }
      return;
    }

    if (fullText.includes('GCP TTS: lang=') || fullText.includes('[useVoiceTTS] GCP TTS')) {
      const textPart = fullText.match(/text="([^"]+)"/)?.[1] || 
                       fullText.match(/text:\s*"([^"]+)"/)?.[1] || '';
      if (textPart) {
        originalWrite({
          ...options,
          message: {
            ...message,
            data: [`\x1b[34m[Hi-Bee Live] 🔊 Speaking: "${textPart}"\x1b[0m`],
          },
        });
      }
      return;
    }

    if (fullText.includes('[runAgent] Fast Action Match:')) {
      const actionMatch = fullText.match(/Fast Action Match:\s*(.+)/)?.[1] || '';
      originalWrite({
        ...options,
        message: {
          ...message,
          data: [`\x1b[32m[Hi-Bee Live] ⚡ Fast Action: ${actionMatch}\x1b[0m`],
        },
      });
      return;
    }

    if (fullText.includes('FastAction completed successfully')) {
      originalWrite({
        ...options,
        message: {
          ...message,
          data: [`\x1b[32m[Hi-Bee Live] ✓ Fast Action Completed\x1b[0m`],
        },
      });
      return;
    }

    if (fullText.includes('[onGUIAgentData] status')) {
      originalWrite({
        ...options,
        message: {
          ...message,
          data: [`\x1b[36m[Hi-Bee Live] 🧠 VLM Step Status: ${fullText.replace(/\\n/g, ' ')}\x1b[0m`],
        },
      });
      return;
    }

    if (fullText === 'runAgent') {
      originalWrite({
        ...options,
        message: {
          ...message,
          data: [`\x1b[33m[Hi-Bee Live] ⚡ Initializing Agent Run...\x1b[0m`],
        },
      });
      return;
    }

    if (fullText.includes('[VAD]')) {
      if (fullText.includes('User started speaking')) {
        originalWrite({
          ...options,
          message: {
            ...message,
            data: [`\x1b[33m[Hi-Bee Live] 🎙️ VAD: User started speaking...\x1b[0m`],
          },
        });
      } else if (fullText.includes('Interrupting')) {
        originalWrite({
          ...options,
          message: {
            ...message,
            data: [`\x1b[31m[Hi-Bee Live] 🎙️ VAD: User interrupted. Stopping TTS.\x1b[0m`],
          },
        });
      }
      return;
    }

    // 3. Keep errors and warnings in their original format so we don't miss issues
    if (message.level === 'error' || message.level === 'warn') {
      originalWrite(options);
    }
  };
}

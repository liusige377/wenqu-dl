/**
 * 问渠下载器 - 授权验证系统
 * 模仿IDM盈利模式：30天免费试用 → 付费激活
 * 1年授权 ¥29.9 / 终身授权 ¥59.9
 */

const { machineIdSync } = require('node-machine-id');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const http = require('http');

class LicenseManager {
  constructor() {
    this.licenseFile = path.join(this._getDataDir(), 'license.dat');
    this.trialStartFile = path.join(this._getDataDir(), 'trial.dat');
    this.trialDays = 30;
    this.publicKey = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2Z3qX8kR5mJ0pL4vN1wP\nKx6fR7jA3mB2cD5eF8gH0iK9lM2nO4pQ7rS6tU8vW1xY3zA5bC6dE8fG0hJ2kL4\nmN6oP8qR3sT5uV7wX9yA1cB3dD5eF7gH0iJ2kL4mN6oP8qR3sT5uV7wX9yA1cB3\ndD5eF7gH0iJ2kL4mN6oP8qR3sT5uV7wX9yA1cB3dD5eF7gH0iJ2kL4mN6oP8qR\n3sT5uV7wX9yA1cB3dD5eF7gH0iJ2kL4mN6oP8qR3sT5uV7wX9yA1cwIDAQAB\n-----END PUBLIC KEY-----';
    this.license = null;
    this._load();
  }

  /**
   * 获取数据目录
   */
  _getDataDir() {
    const dir = path.join(process.env.APPDATA || process.env.HOME, 'WenQuDownloader');
    fs.ensureDirSync(dir);
    return dir;
  }

  /**
   * 获取机器ID
   */
  _getMachineId() {
    try {
      return machineIdSync();
    } catch (e) {
      // 备用方案：用硬件信息生成
      const os = require('os');
      const raw = `${os.hostname()}-${os.cpus()[0]?.model || 'cpu'}-${os.totalmem()}`;
      return crypto.createHash('sha256').update(raw).digest('hex');
    }
  }

  /**
   * 加载授权信息
   */
  _load() {
    try {
      if (fs.existsSync(this.licenseFile)) {
        const data = fs.readJsonSync(this.licenseFile);
        this.license = data;
      }
    } catch (e) {
      this.license = null;
    }
  }

  /**
   * 保存授权信息
   */
  _save() {
    try {
      fs.writeJsonSync(this.licenseFile, this.license, { spaces: 2 });
    } catch (e) {
      console.error('保存授权信息失败:', e);
    }
  }

  /**
   * 获取试用开始时间
   */
  _getTrialStart() {
    try {
      if (fs.existsSync(this.trialStartFile)) {
        const data = fs.readJsonSync(this.trialStartFile);
        return new Date(data.startDate);
      }
    } catch (e) {}
    
    // 首次使用，记录试用开始时间
    const startDate = new Date();
    try {
      fs.writeJsonSync(this.trialStartFile, { startDate: startDate.toISOString() });
    } catch (e) {}
    return startDate;
  }

  /**
   * 检查授权状态
   */
  getStatus() {
    // 已激活
    if (this.license && this.license.activated) {
      // 检查是否过期
      if (this.license.type === 'yearly') {
        const expiry = new Date(this.license.expiryDate);
        if (new Date() > expiry) {
          return {
            status: 'expired',
            message: '授权已过期，请续费',
            type: this.license.type,
            expiryDate: this.license.expiryDate,
            daysLeft: 0
          };
        }
        const daysLeft = Math.ceil((expiry - new Date()) / (1000 * 60 * 60 * 24));
        return {
          status: 'active',
          message: `已激活（${daysLeft}天后到期）`,
          type: this.license.type,
          expiryDate: this.license.expiryDate,
          daysLeft,
          licenseKey: this._maskKey(this.license.key)
        };
      } else if (this.license.type === 'lifetime') {
        return {
          status: 'active',
          message: '已激活（终身授权）',
          type: 'lifetime',
          licenseKey: this._maskKey(this.license.key)
        };
      }
    }

    // 试用期
    const trialStart = this._getTrialStart();
    const now = new Date();
    const daysUsed = Math.floor((now - trialStart) / (1000 * 60 * 60 * 24));
    const daysLeft = Math.max(0, this.trialDays - daysUsed);

    if (daysLeft <= 0) {
      return {
        status: 'trial_expired',
        message: '试用已过期，请购买授权',
        daysLeft: 0,
        trialDays: this.trialDays
      };
    }

    return {
      status: 'trial',
      message: `免费试用（剩余${daysLeft}天）`,
      daysLeft,
      trialDays: this.trialDays
    };
  }

  /**
   * 是否已授权（未过期）
   */
  isLicensed() {
    const status = this.getStatus();
    return status.status === 'active';
  }

  /**
   * 是否在试用期内
   */
  isTrial() {
    const status = this.getStatus();
    return status.status === 'trial';
  }

  /**
   * 是否需要激活
   */
  needsActivation() {
    const status = this.getStatus();
    return status.status !== 'active';
  }

  /**
   * 激活授权码
   */
  async activate(key) {
    // 验证授权码格式：WQ-Y1-XXXX-XXXX（1年）或 WQ-LT-XXXX-XXXX（终身）
    const keyPattern = /^WQ-(Y1|LT)-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
    if (!keyPattern.test(key)) {
      return {
        success: false,
        message: '授权码格式不正确，正确格式：WQ-Y1-XXXX-XXXX 或 WQ-LT-XXXX-XXXX'
      };
    }

    const type = key.startsWith('WQ-Y1') ? 'yearly' : 'lifetime';
    const machineId = this._getMachineId();

    // 在线验证
    try {
      const result = await this._verifyOnline(key, machineId);
      if (result.success) {
        this.license = {
          key, type, machineId, activated: true,
          activateDate: new Date().toISOString(),
          expiryDate: type === 'yearly'
            ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
            : null,
          serverVerified: true,
          verifiedAt: new Date().toISOString()
        };
        this._save();
        return { success: true, message: type === 'yearly' ? '1年授权激活成功！' : '终身授权激活成功！' };
      }
    } catch (e) {
      console.log('在线验证失败，尝试离线验证');
    }

    // 离线验证：基于HMAC校验和
    if (this._validateKeyChecksum(key)) {
      this.license = {
        key, type, machineId, activated: true,
        activateDate: new Date().toISOString(),
        expiryDate: type === 'yearly'
          ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
          : null,
        serverVerified: false
      };
      this._save();
      return { success: true, message: type === 'yearly' ? '1年授权激活成功！（离线模式）' : '终身授权激活成功！（离线模式）' };
    }

    return { success: false, message: '授权码无效，请检查后重试' };
  }

  /**
   * 离线校验Key校验和
   * Key格式: WQ-{type}-{4chars}-{4chars}
   * 校验逻辑: 第2段4字符必须是第1段4字符+密钥的HMAC前4字符
   */
  _validateKeyChecksum(key) {
    const parts = key.split('-');
    if (parts.length !== 4) return false;
    const prefix = parts[0]; // WQ
    const typeCode = parts[1]; // Y1 or LT
    const part1 = parts[2]; // 前4字符
    const part2 = parts[3]; // 后4字符（校验和）

    // 用HMAC-SHA256生成校验码
    const secret = 'wenqu-dl-2026-checksum';
    const hmac = crypto.createHmac('sha256', secret)
      .update(`${prefix}-${typeCode}-${part1}`)
      .digest('hex')
      .toUpperCase();
    
    // 取HMAC前4字符作为校验码
    const expectedPart2 = hmac.substring(0, 4);
    return part2 === expectedPart2;
  }

  /**
   * 在线验证
   */
  _verifyOnline(key, machineId) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ key, machineId });
      const options = {
        hostname: '101.133.136.55',
        port: 3000,
        path: '/v1/license/verify',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        },
        timeout: 10000
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('服务器响应解析失败'));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('验证超时')); });
      req.write(data);
      req.end();
    });
  }

  /**
   * 生成授权码（管理员用）- 带HMAC校验和
   */
  static generateKey(type = 'yearly') {
    const prefix = 'WQ';
    const typeCode = type === 'yearly' ? 'Y1' : 'LT';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let part1 = '';
    for (let i = 0; i < 4; i++) {
      part1 += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    // 用HMAC生成校验码
    const secret = 'wenqu-dl-2026-checksum';
    const hmac = crypto.createHmac('sha256', secret)
      .update(`${prefix}-${typeCode}-${part1}`)
      .digest('hex')
      .toUpperCase();
    const part2 = hmac.substring(0, 4);
    return `${prefix}-${typeCode}-${part1}-${part2}`;
  }

  /**
   * 批量生成授权码
   */
  static generateBatch(type, count) {
    const keys = [];
    for (let i = 0; i < count; i++) {
      keys.push(LicenseManager.generateKey(type));
    }
    return keys;
  }

  /**
   * 遮蔽授权码
   */
  _maskKey(key) {
    if (!key || key.length < 12) return '****';
    return key.substring(0, 7) + '****' + key.substring(key.length - 4);
  }

  /**
   * 获取授权信息
   */
  getInfo() {
    return this.license;
  }

  /**
   * 注销授权
   */
  deactivate() {
    this.license = null;
    try { fs.removeSync(this.licenseFile); } catch (e) {}
    return { success: true, message: '授权已注销' };
  }
}

module.exports = LicenseManager;

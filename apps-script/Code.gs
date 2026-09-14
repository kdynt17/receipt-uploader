const CONFIG = Object.freeze({
  APP_NAME: '영수증 제출함',
  STORAGE_FOLDER_NAME: '영수증 제출함 - 비공개 보관',
  LOG_SPREADSHEET_NAME: '영수증 제출함 - 접수 기록',
  LOG_SHEET_NAME: '제출내역',
  RETENTION_DAYS: 30,
  MAX_FILE_BYTES: 8 * 1024 * 1024,
  PUBLIC_PAGE_URL: 'https://kdynt17.github.io/receipt-uploader/',
  ALLOWED_FILES: Object.freeze({
    pdf: Object.freeze({ mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }),
    jpg: Object.freeze({ mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] }),
    jpeg: Object.freeze({ mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] }),
    png: Object.freeze({ mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }),
  }),
});

const PROPERTY_KEYS = Object.freeze({
  FOLDER_ID: 'RECEIPT_FOLDER_ID',
  SPREADSHEET_ID: 'RECEIPT_SPREADSHEET_ID',
});

function doGet() {
  const template = HtmlService.createTemplateFromFile('Index');
  template.appName = CONFIG.APP_NAME;
  template.maxFileMb = CONFIG.MAX_FILE_BYTES / 1024 / 1024;
  template.retentionDays = CONFIG.RETENTION_DAYS;
  template.publicPageUrl = CONFIG.PUBLIC_PAGE_URL;

  return template
    .evaluate()
    .setTitle(CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .addMetaTag('referrer', 'no-referrer');
}

/**
 * Run once from the editor before deploying the web app.
 * Creates an app-owned private folder, a private log sheet, and a daily purge trigger.
 */
function setupReceiptApp() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const properties = PropertiesService.getScriptProperties();
    let folderId = properties.getProperty(PROPERTY_KEYS.FOLDER_ID);
    let spreadsheetId = properties.getProperty(PROPERTY_KEYS.SPREADSHEET_ID);

    if (!folderId) {
      const folder = Drive.Files.create({
        name: CONFIG.STORAGE_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: { receiptUploader: 'storage-v1' },
      });
      folderId = folder.id;
      properties.setProperty(PROPERTY_KEYS.FOLDER_ID, folderId);
    }

    if (!spreadsheetId) {
      const spreadsheet = SpreadsheetApp.create(CONFIG.LOG_SPREADSHEET_NAME);
      spreadsheetId = spreadsheet.getId();

      const metadata = Drive.Files.get(spreadsheetId, { fields: 'parents' });
      const previousParents = (metadata.parents || []).join(',');
      Drive.Files.update(
        { appProperties: { receiptUploader: 'log-v1' } },
        spreadsheetId,
        null,
        {
          addParents: folderId,
          removeParents: previousParents,
          fields: 'id,parents',
        }
      );

      initializeLogSheet_(spreadsheet);
      properties.setProperty(PROPERTY_KEYS.SPREADSHEET_ID, spreadsheetId);
    }

    ensureCleanupTrigger_();

    return {
      ok: true,
      folderUrl: 'https://drive.google.com/drive/folders/' + folderId,
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/edit',
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Receives the Apps Script HTML form. File inputs arrive as Blob objects.
 * No submitter email, IP address, original filename, or browser metadata is recorded.
 */
function submitReceipt(formObject) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    throw new Error('현재 제출이 몰리고 있습니다. 잠시 후 다시 시도해 주세요.');
  }

  let createdFileId = null;

  try {
    const storage = getStorage_();
    const submission = validateSubmission_(formObject);
    const cache = CacheService.getScriptCache();
    const cacheKey = 'receipt-nonce-' + submission.nonce;
    const existingReference = cache.get(cacheKey);

    if (existingReference) {
      return { ok: true, reference: existingReference, duplicate: true };
    }

    const submittedAt = new Date();
    const expiresAt = new Date(
      submittedAt.getTime() + CONFIG.RETENTION_DAYS * 24 * 60 * 60 * 1000
    );
    const reference = createReference_(submittedAt);
    const storedName = 'receipt_' + Utilities.getUuid() + '.' + submission.extension;
    const storedBlob = submission.blob
      .copyBlob()
      .setName(storedName)
      .setContentType(submission.mime);

    const driveFile = Drive.Files.create(
      {
        name: storedName,
        mimeType: submission.mime,
        parents: [storage.folderId],
        appProperties: {
          receiptUploader: 'receipt-v1',
          expiresOn: Utilities.formatDate(expiresAt, 'UTC', 'yyyy-MM-dd'),
        },
      },
      storedBlob,
      { fields: 'id,size,createdTime' }
    );
    createdFileId = driveFile.id;

    const sheet = SpreadsheetApp.openById(storage.spreadsheetId).getSheetByName(
      CONFIG.LOG_SHEET_NAME
    );
    if (!sheet) {
      throw new Error('저장 설정을 확인할 수 없습니다. 관리자에게 문의해 주세요.');
    }

    sheet.appendRow([
      reference,
      submittedAt,
      submission.name,
      submission.mime,
      submission.bytes.length,
      sha256Hex_(submission.bytes),
      createdFileId,
      expiresAt,
    ]);

    cache.put(cacheKey, reference, 21600);
    return { ok: true, reference: reference, duplicate: false };
  } catch (error) {
    if (createdFileId) {
      try {
        Drive.Files.remove(createdFileId);
      } catch (cleanupError) {
        // Never log file data or the submitter's name.
        console.error('ROLLBACK_FAILED');
      }
    }

    if (isPublicError_(error)) {
      throw error;
    }
    console.error('SUBMISSION_FAILED');
    throw new Error('제출을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Permanently deletes expired receipt files and their identifying log rows.
 * Google Workspace administrators may still retain provider-level backups under policy.
 */
function cleanupExpiredReceipts() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const storage = getStorage_();
    const sheet = SpreadsheetApp.openById(storage.spreadsheetId).getSheetByName(
      CONFIG.LOG_SHEET_NAME
    );
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const values = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
    const now = new Date();

    for (let index = values.length - 1; index >= 0; index -= 1) {
      const fileId = String(values[index][6] || '');
      const expiresAt = values[index][7];
      if (!(expiresAt instanceof Date) || expiresAt > now) continue;

      if (fileId) {
        try {
          Drive.Files.remove(fileId);
        } catch (error) {
          const message = String(error && error.message ? error.message : '');
          if (!/not found|File not found|404/i.test(message)) {
            console.error('RETENTION_DELETE_FAILED');
            continue;
          }
        }
      }
      sheet.deleteRow(index + 2);
    }
  } finally {
    lock.releaseLock();
  }
}

function initializeLogSheet_(spreadsheet) {
  const sheet = spreadsheet.getSheets()[0];
  sheet.setName(CONFIG.LOG_SHEET_NAME);
  sheet.getRange(1, 1, 1, 8).setValues([[
    '접수번호',
    '접수시각',
    '이름',
    '파일형식',
    '파일크기(bytes)',
    'SHA-256',
    'Drive 파일 ID',
    '자동삭제시각',
  ]]);
  sheet.setFrozenRows(1);
  sheet.getRange('B:B').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('H:H').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('A:H').setWrap(false);
  sheet.autoResizeColumns(1, 8);
}

function ensureCleanupTrigger_() {
  const exists = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === 'cleanupExpiredReceipts';
  });

  if (!exists) {
    ScriptApp.newTrigger('cleanupExpiredReceipts')
      .timeBased()
      .everyDays(1)
      .atHour(3)
      .create();
  }
}

function getStorage_() {
  const properties = PropertiesService.getScriptProperties();
  const folderId = properties.getProperty(PROPERTY_KEYS.FOLDER_ID);
  const spreadsheetId = properties.getProperty(PROPERTY_KEYS.SPREADSHEET_ID);

  if (!folderId || !spreadsheetId) {
    throw new Error('저장 설정이 완료되지 않았습니다. 관리자에게 문의해 주세요.');
  }
  return { folderId: folderId, spreadsheetId: spreadsheetId };
}

function validateSubmission_(formObject) {
  if (!formObject || formObject.consent !== 'yes') {
    throw publicError_('개인정보 수집·이용에 동의해야 제출할 수 있습니다.');
  }

  const name = String(formObject.submitterName || '').normalize('NFC').trim();
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,49}$/u.test(name)) {
    throw publicError_('이름은 문자 중심으로 2~50자 이내로 입력해 주세요.');
  }

  const nonce = String(formObject.submissionNonce || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)) {
    throw publicError_('제출 페이지를 새로고침한 뒤 다시 시도해 주세요.');
  }

  const blob = formObject.receiptFile;
  if (!blob || typeof blob.getBytes !== 'function') {
    throw publicError_('영수증 파일을 선택해 주세요.');
  }

  const originalName = String(blob.getName() || '');
  const extensionMatch = originalName.toLowerCase().match(/\.([a-z0-9]+)$/);
  const extension = extensionMatch ? extensionMatch[1] : '';
  const allowed = CONFIG.ALLOWED_FILES[extension];
  if (!allowed) {
    throw publicError_('PDF, JPG, JPEG, PNG 파일만 제출할 수 있습니다.');
  }

  const mime = String(blob.getContentType() || '').toLowerCase();
  if (mime !== allowed.mime) {
    throw publicError_('파일 확장자와 실제 파일 형식이 일치하지 않습니다.');
  }

  const bytes = blob.getBytes();
  if (bytes.length < allowed.magic.length || bytes.length > CONFIG.MAX_FILE_BYTES) {
    throw publicError_('파일은 비어 있지 않아야 하며 ' +
      CONFIG.MAX_FILE_BYTES / 1024 / 1024 + 'MB 이하여야 합니다.');
  }

  for (let index = 0; index < allowed.magic.length; index += 1) {
    if ((bytes[index] & 0xff) !== allowed.magic[index]) {
      throw publicError_('파일 내용이 허용된 PDF 또는 이미지 형식이 아닙니다.');
    }
  }

  return {
    name: name,
    nonce: nonce,
    blob: blob,
    bytes: bytes,
    extension: extension === 'jpeg' ? 'jpg' : extension,
    mime: allowed.mime,
  };
}

function sha256Hex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(function (value) {
      return ((value & 0xff) + 0x100).toString(16).slice(1);
    })
    .join('');
}

function createReference_(date) {
  const datePart = Utilities.formatDate(date, 'Asia/Seoul', 'yyyyMMdd');
  const randomPart = Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
  return 'R-' + datePart + '-' + randomPart;
}

function publicError_(message) {
  const error = new Error(message);
  error.isPublic = true;
  return error;
}

function isPublicError_(error) {
  return Boolean(error && error.isPublic === true);
}


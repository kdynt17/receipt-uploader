const CONFIG = Object.freeze({
  APP_NAME: '중화중학교 AI 영수증 제출',
  STORAGE_FOLDER_NAME: '영수증 제출함 - 비공개 보관',
  LOG_SPREADSHEET_NAME: '영수증 제출함 - 접수 기록',
  LOG_SHEET_NAME: '제출내역',
  MAX_FILE_BYTES: 8 * 1024 * 1024,
  MAX_SUBMISSIONS_PER_HOUR: 60,
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

  return template
    .evaluate()
    .setTitle(CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Run once from the editor before deploying the web app.
 * Creates an app-owned private folder and a private log sheet.
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

      properties.setProperty(PROPERTY_KEYS.SPREADSHEET_ID, spreadsheetId);
    }

    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    migrateLogSheet_(spreadsheet);
    disableCleanupTriggers_();

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
 * Run once after upgrading from the former 30-day-retention version.
 * Preserves existing receipt rows, updates their column order, and removes purge triggers.
 */
function applyReceiptAppUpdate() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const storage = getStorage_();
    const spreadsheet = SpreadsheetApp.openById(storage.spreadsheetId);
    migrateLogSheet_(spreadsheet);
    return {
      ok: true,
      removedCleanupTriggers: disableCleanupTriggers_(),
      automaticDeletion: false,
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

    enforceHourlySubmissionLimit_();

    const submittedAt = new Date();
    const reference = createReference_(submittedAt);
    const storedName = createStoredFilename_(submission);
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
        },
      },
      storedBlob,
      { fields: 'id,size,createdTime' }
    );
    createdFileId = driveFile.id;

    const spreadsheet = SpreadsheetApp.openById(storage.spreadsheetId);
    migrateLogSheet_(spreadsheet);
    const sheet = spreadsheet.getSheetByName(CONFIG.LOG_SHEET_NAME);
    if (!sheet) {
      throw new Error('저장 설정을 확인할 수 없습니다. 관리자에게 문의해 주세요.');
    }

    sheet.appendRow([
      safeSheetText_(submission.name),
      safeSheetText_(submission.purchaseDescription),
      submission.purchaseDate,
      submittedAt,
      reference,
      submission.mime,
      submission.bytes.length,
      sha256Hex_(submission.bytes),
      createdFileId,
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
 * Compatibility no-op for any old trigger that has not yet been removed.
 * This function intentionally never deletes files or spreadsheet rows.
 */
function cleanupExpiredReceipts() {
  return { ok: true, automaticDeletion: false };
}

function migrateLogSheet_(spreadsheet) {
  const oldHeaders = [
    '접수번호', '접수시각', '이름', '파일형식', '파일크기(bytes)',
    'SHA-256', 'Drive 파일 ID', '자동삭제시각',
  ];
  const newHeaders = [
    '이름',
    '구매내용',
    '구매일자',
    '접수시각',
    '접수번호',
    '파일형식',
    '파일크기(bytes)',
    'SHA-256',
    'Drive 파일 ID',
  ];

  let sheet = spreadsheet.getSheetByName(CONFIG.LOG_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.getSheets()[0] || spreadsheet.insertSheet();
    sheet.setName(CONFIG.LOG_SHEET_NAME);
  }

  const lastRow = sheet.getLastRow();
  const existingHeaders = lastRow > 0
    ? sheet.getRange(1, 1, 1, newHeaders.length).getDisplayValues()[0]
    : [];
  const isOldSchema = headersMatch_(existingHeaders, oldHeaders);
  const isNewSchema = headersMatch_(existingHeaders, newHeaders);

  if (isOldSchema) {
    const rowCount = Math.max(0, lastRow - 1);
    const oldRows = rowCount > 0
      ? sheet.getRange(2, 1, rowCount, oldHeaders.length).getValues()
      : [];
    const migratedRows = oldRows.map(function (row) {
      return [
        row[2],
        '',
        '',
        row[1],
        row[0],
        row[3],
        row[4],
        row[5],
        row[6],
      ];
    });

    if (rowCount > 0) {
      sheet.getRange(2, 1, rowCount, newHeaders.length).clearContent();
    }
    sheet.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
    if (migratedRows.length > 0) {
      sheet.getRange(2, 1, migratedRows.length, newHeaders.length).setValues(migratedRows);
    }
  } else if (!isNewSchema) {
    const hasContent = existingHeaders.some(function (value) { return value !== ''; });
    if (hasContent) {
      throw new Error('접수 기록의 열 구성을 자동으로 확인할 수 없습니다.');
    }
    sheet.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
  }

  sheet.setFrozenRows(1);
  sheet.getRange('D:D').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('A:I').setWrap(false);
  sheet.getRange(1, 1, 1, newHeaders.length)
    .setBackground('#f1f3f4')
    .setFontWeight('bold');
  [140, 240, 105, 165, 190, 120, 120, 420, 260].forEach(function (width, index) {
    sheet.setColumnWidth(index + 1, width);
  });
}

function headersMatch_(actual, expected) {
  return expected.every(function (value, index) {
    return actual[index] === value;
  });
}

function disableCleanupTriggers_() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'cleanupExpiredReceipts') {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    }
  });
  return removed;
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

  if (String(formObject.website || '').trim() !== '') {
    throw publicError_('제출 정보를 확인할 수 없습니다. 페이지를 새로고침해 주세요.');
  }

  const name = String(formObject.submitterName || '').normalize('NFC').trim();
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,49}$/u.test(name)) {
    throw publicError_('이름은 문자 중심으로 2~50자 이내로 입력해 주세요.');
  }

  const purchaseDescription = String(formObject.purchaseDescription || '')
    .normalize('NFC')
    .trim();
  if (purchaseDescription.length < 1 || purchaseDescription.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(purchaseDescription)) {
    throw publicError_('구매한 물품은 1~100자 이내로 입력해 주세요.');
  }

  const purchaseDate = String(formObject.purchaseDate || '');
  const dateMatch = purchaseDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) {
    throw publicError_('구매일자를 올바르게 선택해 주세요.');
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const parsedDate = new Date(year, month - 1, day, 12, 0, 0);
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  if (parsedDate.getFullYear() !== year || parsedDate.getMonth() !== month - 1 ||
      parsedDate.getDate() !== day || parsedDate > today) {
    throw publicError_('구매일자는 오늘 또는 이전 날짜여야 합니다.');
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
    purchaseDescription: purchaseDescription,
    purchaseDate: purchaseDate,
    nonce: nonce,
    blob: blob,
    bytes: bytes,
    extension: extension === 'jpeg' ? 'jpg' : extension,
    mime: allowed.mime,
  };
}

function safeSheetText_(value) {
  const text = String(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function createStoredFilename_(submission) {
  const datePart = submission.purchaseDate;
  const namePart = sanitizeFilenamePart_(submission.name, 30);
  const itemPart = sanitizeFilenamePart_(submission.purchaseDescription, 50);
  const uniquePart = Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
  return [datePart, namePart, itemPart, uniquePart].join('_') + '.' + submission.extension;
}

function sanitizeFilenamePart_(value, maxCharacters) {
  const cleaned = String(value)
    .normalize('NFKC')
    .replace(/[<>:\"/\\|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  const shortened = Array.from(cleaned).slice(0, maxCharacters).join('');
  return shortened || '미입력';
}

function enforceHourlySubmissionLimit_() {
  const cache = CacheService.getScriptCache();
  const hourKey = 'receipt-hour-' + Utilities.formatDate(
    new Date(),
    'Asia/Seoul',
    'yyyyMMddHH'
  );
  const currentCount = Number(cache.get(hourKey) || 0);
  if (currentCount >= CONFIG.MAX_SUBMISSIONS_PER_HOUR) {
    throw publicError_('현재 제출이 많습니다. 잠시 후 다시 시도해 주세요.');
  }
  cache.put(hourKey, String(currentCount + 1), 3600);
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


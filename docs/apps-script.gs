/**
 * 4Skills lead capture — Google Apps Script
 * =========================================
 *
 * Appends each lead to a Google Sheet. Free, no API keys, no service account.
 *
 * SETUP (about five minutes, done once)
 * -------------------------------------
 * 1. Go to sheets.new and create a sheet. Name it something like "4Skills leads".
 * 2. Extensions -> Apps Script. Delete whatever is in the editor.
 * 3. Paste this entire file in.
 * 4. Set NOTIFY_EMAIL below to the address that should be emailed when a new
 *    enquiry arrives, e.g. 'englishlanguageclub.faisalabad@gmail.com'. Leave it
 *    as '' if you do not want emails. Save.
 * 5. Run -> select `setupHeaders` -> Run. Approve the permission prompt the
 *    first time. It will ask for permission to write to your own sheet and to
 *    send email as you — both are needed.
 * 6. Deploy -> New deployment -> gear icon -> Web app.
 *       Execute as:        Me
 *       Who has access:    Anyone
 *    "Anyone" is required — Vercel calls this without a Google login. The URL is
 *    the only secret, so do not paste it anywhere public.
 * 7. Copy the /exec URL it gives you into the Vercel environment variable
 *    LEAD_WEBHOOK_URL, then redeploy the Vercel project.
 *
 * IMPORTANT: after editing this file you must Deploy -> Manage deployments ->
 * edit -> Version: New version. Saving alone does not update the live web app.
 *
 * To verify it works, run `testAppend` from the editor and check the sheet.
 */

var SHEET_NAME = 'Leads';

/**
 * Who gets an email when a new enquiry arrives. Set this to the address that
 * actually gets read during office hours — a lead is only worth having if
 * somebody sees it the same day.
 *
 * Several addresses: separate with commas, no spaces.
 *   var NOTIFY_EMAIL = 'a@4skills.co,b@4skills.co';
 *
 * Set it to '' to switch notifications off. The row is still written either way.
 *
 * Quota: a normal Gmail account can send about 100 emails a day from Apps
 * Script (Workspace accounts get 1,500). Past that, sending fails for the rest
 * of the day and resumes automatically the next. That is far above the enquiry
 * volume this site gets, and if it were ever hit the row would still be written
 * — you would just have to read the sheet rather than your inbox.
 */
var NOTIFY_EMAIL = '';

var HEADERS = [
  'Timestamp',
  'Name',
  'Phone',
  'Course',
  'Session ID',
  'Transcript',
  'Page URL',
  'Referrer',
];

function getSheet_() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(SHEET_NAME);
  }
  return sheet;
}

/** Run once from the editor. Safe to run again — it will not duplicate. */
function setupHeaders() {
  var sheet = getSheet_();
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
  }
  sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(6, 400); // transcript needs the room
  return 'Headers ready.';
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var sheet = getSheet_();

    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    // A leading apostrophe keeps Sheets from mangling +923... into a number or
    // a formula. Same reason the transcript is forced to a string.
    sheet.appendRow([
      data.timestamp || new Date().toISOString(),
      data.name || '',
      "'" + (data.phone || ''),
      data.course || '',
      data.sessionId || '',
      String(data.transcript || ''),
      data.pageUrl || '',
      data.referrer || '',
    ]);

    // The row is already safely written by this point. Notification is a
    // convenience on top of it, so it gets its own try/catch — a mail quota or
    // a typo'd address must never cost us the lead or turn the response into an
    // error the widget would show the visitor.
    notify_(data, sheet);

    return json_({ ok: true });
  } catch (err) {
    // Logged to Apps Script's execution log, visible under "Executions".
    console.error('lead append failed: ' + err);
    return json_({ ok: false, error: String(err) });
  }
}

/**
 * Email the team about a new enquiry. Never throws.
 */
function notify_(data, sheet) {
  try {
    if (!NOTIFY_EMAIL) return;

    var name = data.name || 'Unknown';
    var phone = data.phone || '';
    var sheetUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();

    // wa.me wants digits only, no leading +.
    var waNumber = String(phone).replace(/[^0-9]/g, '');

    var body =
      'A new enquiry came in through the website assistant.\n\n' +
      'Name:    ' + name + '\n' +
      'Phone:   ' + phone + '\n' +
      'Course:  ' + (data.course || 'Not specified') + '\n' +
      'Page:    ' + (data.pageUrl || '') + '\n\n' +
      (waNumber ? 'WhatsApp them: https://wa.me/' + waNumber + '\n\n' : '') +
      'What they asked:\n' +
      (data.transcript || '(no conversation recorded)') + '\n\n' +
      'Full sheet: ' + sheetUrl + '\n';

    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      subject: 'New 4Skills enquiry — ' + name,
      body: body,
    });
  } catch (err) {
    // Visible under Executions in the Apps Script editor. The row is already in
    // the sheet, so this is a missed email, not a missed lead.
    console.error('lead notification failed (row was still saved): ' + err);
  }
}

/** Browsers hitting the URL directly get something harmless. */
function doGet() {
  return json_({ ok: true, service: '4skills-leads' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

/** Run from the editor to confirm the sheet wiring works. */
function testAppend() {
  doPost({
    postData: {
      contents: JSON.stringify({
        timestamp: new Date().toISOString(),
        name: 'Test Entry',
        phone: '+923001234567',
        course: 'IELTS Academic',
        sessionId: 'manual-test',
        transcript: 'Visitor: test\nBot: test',
        pageUrl: 'https://4skills.co/',
        referrer: '',
      }),
    },
  });
  return 'Appended. Check the Leads sheet.';
}

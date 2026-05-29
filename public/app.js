// Global State Management
let selectedDate = null;
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth(); // 0-indexed
let calendarCampaigns = {};
let currentStatus = 'IDLE';
let recipientsList = [];
let logsList = [];
let activeInput = null;
let currentFilter = 'all';
let currentSearch = '';
let settingsData = { smtpUser: '', smtpPass: '', intervalMinutes: 3, testEmail: '', trackingUrl: '' };
let settingsLoaded = false;
let fileReferenceCleared = false;

// Pagination State
let currentPage = 1;
let pageSize = 25;

// UI Elements
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileInfo = document.getElementById('file-info');
const fileNameEl = document.getElementById('file-name');
const fileSizeEl = document.getElementById('file-size');
const removeFileBtn = document.getElementById('remove-file-btn');

const subjectInput = document.getElementById('email-subject');
const bodyInput = document.getElementById('email-body');

const startBtn = document.getElementById('start-btn');
const pauseBtn = document.getElementById('pause-btn');
const resetBtn = document.getElementById('reset-btn');

const smtpUserInput = document.getElementById('smtp-user');
const smtpPassInput = document.getElementById('smtp-pass');
const intervalSlider = document.getElementById('interval-minutes');
const intervalReadout = document.getElementById('interval-readout');
const testEmailTargetInput = document.getElementById('test-email-target');
const trackingUrlInput = document.getElementById('tracking-url');
const testConnectionBtn = document.getElementById('test-connection-btn');
const testConnectionResult = document.getElementById('test-connection-result');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const togglePasswordBtn = document.getElementById('toggle-password');

const metricSent = document.getElementById('metric-sent');
const metricOpened = document.getElementById('metric-opened');
const metricClicked = document.getElementById('metric-clicked');
const metricPending = document.getElementById('metric-pending');
const metricFailed = document.getElementById('metric-failed');
const metricRate = document.getElementById('metric-rate');

const progressText = document.getElementById('progress-text');
const progressFill = document.getElementById('progress-fill');
const countdownCard = document.getElementById('countdown-card');
const countdownText = document.getElementById('countdown-text');

const consoleTerminal = document.getElementById('console-terminal');
const clearLogsBtn = document.getElementById('clear-logs-btn');

const queueTbody = document.getElementById('queue-tbody');
const queueSearchInput = document.getElementById('queue-search');

const campaignStatusBadge = document.getElementById('campaign-status');
const connectionStatusBadge = document.getElementById('connection-status');

/* ==========================================================================
   Tab Navigation Router
   ========================================================================== */
window.switchTab = function(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
  
  // Find trigger button
  const triggerBtn = Array.from(document.querySelectorAll('.tab-btn')).find(
    btn => btn.getAttribute('onclick').includes(tabId)
  );
  if (triggerBtn) triggerBtn.classList.add('active');
  
  const activeContent = document.getElementById(tabId);
  if (activeContent) activeContent.classList.add('active');
  
  if (tabId === 'tab-composer') {
    if (!selectedDate) {
      document.getElementById('composer-calendar-view').style.display = 'block';
      document.getElementById('composer-dashboard-view').style.display = 'none';
      fetchCalendarCampaigns();
    } else {
      document.getElementById('composer-calendar-view').style.display = 'none';
      document.getElementById('composer-dashboard-view').style.display = 'block';
    }
  }
};

/* ==========================================================================
   Calendar Logic
   ========================================================================== */
window.prevMonth = function() {
  currentMonth--;
  if (currentMonth < 0) {
    currentMonth = 11;
    currentYear--;
  }
  fetchCalendarCampaigns();
};

window.nextMonth = function() {
  currentMonth++;
  if (currentMonth > 11) {
    currentMonth = 0;
    currentYear++;
  }
  fetchCalendarCampaigns();
};

window.fetchCalendarCampaigns = async function() {
  try {
    const response = await fetch('/api/campaigns/list');
    if (response.ok) {
      calendarCampaigns = await response.json();
    }
  } catch (error) {
    console.error('Error fetching campaigns list for calendar:', error);
  }
  renderCalendar();
};

window.renderCalendar = function() {
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  
  // Update header text
  const headerEl = document.getElementById('calendar-month-year');
  if (headerEl) {
    headerEl.textContent = `${monthNames[currentMonth]} ${currentYear}`;
  }
  
  const gridEl = document.getElementById('calendar-days-grid');
  if (!gridEl) return;
  
  gridEl.innerHTML = '';
  
  const firstDay = new Date(currentYear, currentMonth, 1).getDay();
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  
  // Render empty cells for offset
  for (let i = 0; i < firstDay; i++) {
    const emptyCell = document.createElement('div');
    emptyCell.className = 'calendar-day-cell empty-day';
    gridEl.appendChild(emptyCell);
  }
  
  const today = new Date();
  
  // Render day cells
  for (let day = 1; day <= daysInMonth; day++) {
    const cell = document.createElement('div');
    cell.className = 'calendar-day-cell';
    
    const dayStr = String(day).padStart(2, '0');
    const monthStr = String(currentMonth + 1).padStart(2, '0');
    const dateStr = `${currentYear}-${monthStr}-${dayStr}`;
    
    // Highlight today
    if (today.getDate() === day && today.getMonth() === currentMonth && today.getFullYear() === currentYear) {
      cell.classList.add('today');
    }
    
    cell.setAttribute('onclick', `loadCampaignForDate('${dateStr}')`);
    
    // Day number
    const numEl = document.createElement('div');
    numEl.className = 'day-number';
    numEl.textContent = day;
    cell.appendChild(numEl);
    
    // Campaign details/badges if any
    const camp = calendarCampaigns[dateStr];
    if (camp) {
      const badge = document.createElement('div');
      const statusLower = (camp.status || 'idle').toLowerCase();
      badge.className = `campaign-badge ${statusLower}`;
      
      const title = document.createElement('div');
      title.className = 'campaign-title';
      title.textContent = camp.subject || '(No Subject)';
      badge.appendChild(title);
      
      const meta = document.createElement('div');
      meta.className = 'campaign-meta';
      
      const dot = document.createElement('span');
      dot.className = `status-dot ${statusLower}`;
      meta.appendChild(dot);
      
      const text = document.createElement('span');
      text.textContent = `${camp.count} contact${camp.count !== 1 ? 's' : ''}`;
      meta.appendChild(text);
      
      badge.appendChild(meta);
      cell.appendChild(badge);
    }
    
    gridEl.appendChild(cell);
  }
  
  // Refresh Lucide icons if any
  if (window.lucide) {
    lucide.createIcons();
  }
};

window.loadCampaignForDate = function(dateStr) {
  selectedDate = dateStr;
  
  document.getElementById('composer-calendar-view').style.display = 'none';
  document.getElementById('composer-dashboard-view').style.display = 'block';
  
  const labelEl = document.getElementById('active-campaign-date-label');
  if (labelEl) {
    labelEl.textContent = `Campaign for: ${dateStr}`;
  }
  
  // Clear file references in UI and reset loaded campaign details
  fileReferenceCleared = false;
  settingsLoaded = false;
  
  // Clear fields momentarily to show loading
  subjectInput.value = '';
  bodyInput.value = '';
  
  fetchStatus();
};

window.backToCalendar = function() {
  selectedDate = null;
  document.getElementById('composer-calendar-view').style.display = 'block';
  document.getElementById('composer-dashboard-view').style.display = 'none';
  fetchCalendarCampaigns();
};


/* ==========================================================================
   Cursor focus tracking for placeholder tags injection
   ========================================================================== */
subjectInput.addEventListener('focus', () => { activeInput = subjectInput; });
bodyInput.addEventListener('focus', () => { activeInput = bodyInput; });

window.insertPlaceholder = function(name) {
  const target = activeInput || bodyInput;
  const tag = `{{${name}}}`;
  const start = target.selectionStart || 0;
  const end = target.selectionEnd || 0;
  const text = target.value;
  
  target.value = text.substring(0, start) + tag + text.substring(end);
  target.focus();
  target.selectionStart = target.selectionEnd = start + tag.length;
};

/* ==========================================================================
   Drag & Drop Event Handlers
   ========================================================================== */
['dragenter', 'dragover'].forEach(eventName => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  }, false);
});

['dragleave', 'drop'].forEach(eventName => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  }, false);
});

dropZone.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  const files = dt.files;
  if (files.length > 0) {
    handleFileUpload(files[0]);
  }
});

dropZone.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleFileUpload(e.target.files[0]);
  }
});

removeFileBtn.addEventListener('click', () => {
  resetCampaignState();
});

/* ==========================================================================
   Upload Request Handler
   ========================================================================== */
async function handleFileUpload(file) {
  const formData = new FormData();
  formData.append('file', file);
  
  showTerminalLog(`Uploading and parsing file: ${file.name}...`, 'info');
  
  // Set UI temporary file info
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = `${(file.size / 1024).toFixed(1)} KB`;
  
  try {
    const response = await fetch(`/api/upload-recipients?date=${selectedDate}`, {
      method: 'POST',
      body: formData
    });
    
    const result = await response.json();
    if (response.ok) {
      showTerminalLog(`Successfully parsed sheet! Loaded ${result.count} contacts.`, 'success');
      fileReferenceCleared = false;
      dropZone.style.display = 'none';
      fileInfo.style.display = 'flex';
      await fetchStatus();
    } else {
      showTerminalLog(`Upload Failed: ${result.error}`, 'error');
      alert(result.error);
    }
  } catch (error) {
    console.error('Upload error:', error);
    showTerminalLog(`Network error during file parsing: ${error.message}`, 'error');
    alert('Failed to connect to backend server upload route.');
  }
}

/* ==========================================================================
   SMTP Password Eye Toggle Icon Changer
   ========================================================================== */
togglePasswordBtn.addEventListener('click', () => {
  const type = smtpPassInput.getAttribute('type') === 'password' ? 'text' : 'password';
  smtpPassInput.setAttribute('type', type);
  
  // Change toggle button icon dynamically
  const icon = togglePasswordBtn.querySelector('i');
  if (type === 'text') {
    icon.setAttribute('data-lucide', 'eye-off');
  } else {
    icon.setAttribute('data-lucide', 'eye');
  }
  lucide.createIcons();
});

/* ==========================================================================
   Save Configurations Handler
   ========================================================================== */
intervalSlider.addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  if (val < 1) {
    const sec = Math.round(val * 60);
    intervalReadout.textContent = `Every ${sec} seconds`;
  } else {
    intervalReadout.textContent = `Every ${val.toFixed(1)} mins`;
  }
});

saveSettingsBtn.addEventListener('click', async () => {
  const selectedDays = Array.from(document.querySelectorAll('input[name="schedule-day"]:checked')).map(el => parseInt(el.value));
  
  const payload = {
    smtpUser: smtpUserInput.value.trim(),
    smtpPass: smtpPassInput.value,
    intervalMinutes: parseFloat(intervalSlider.value),
    testEmail: testEmailTargetInput.value.trim(),
    trackingUrl: trackingUrlInput.value.trim(),
    scheduleEnabled: document.getElementById('schedule-enabled').checked,
    scheduleStartDate: document.getElementById('schedule-start-date').value,
    scheduleAllowedStart: document.getElementById('schedule-allowed-start').value,
    scheduleAllowedEnd: document.getElementById('schedule-allowed-end').value,
    scheduleDays: selectedDays
  };
  
  if (!payload.smtpUser) {
    alert('Please enter a Gmail user address.');
    return;
  }
  
  saveSettingsBtn.disabled = true;
  saveSettingsBtn.innerHTML = '<i class="spin-icon" data-lucide="loader"></i> Saving...';
  lucide.createIcons();
  
  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (response.ok) {
      showTerminalLog('Settings saved successfully.', 'success');
      alert('SMTP settings saved successfully!');
      settingsLoaded = false;
      await fetchStatus();
    } else {
      const err = await response.json();
      showTerminalLog(`Failed saving settings: ${err.error}`, 'error');
      alert(err.error);
    }
  } catch (error) {
    showTerminalLog(`Error saving config settings: ${error.message}`, 'error');
  } finally {
    saveSettingsBtn.disabled = false;
    saveSettingsBtn.innerHTML = '<i data-lucide="save"></i> Save Settings';
    lucide.createIcons();
  }
});

/* ==========================================================================
   Verify SMTP Credentials and Connection
   ========================================================================== */
testConnectionBtn.addEventListener('click', async () => {
  const payload = {
    smtpUser: smtpUserInput.value.trim(),
    smtpPass: smtpPassInput.value,
    testEmail: testEmailTargetInput.value.trim()
  };
  
  if (!payload.smtpUser) {
    alert('Please supply your Gmail address for SMTP authentication testing.');
    return;
  }
  
  testConnectionBtn.disabled = true;
  testConnectionBtn.innerHTML = '<i class="spin-icon" data-lucide="loader"></i> Dispatching test mail...';
  testConnectionResult.style.display = 'none';
  lucide.createIcons();
  
  try {
    const response = await fetch('/api/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const result = await response.json();
    testConnectionResult.style.display = 'block';
    
    if (response.ok) {
      testConnectionResult.className = 'result-message success';
      testConnectionResult.textContent = result.message;
      showTerminalLog(`SMTP Test Connection success. Mail sent to ${payload.testEmail || payload.smtpUser}.`, 'success');
    } else {
      testConnectionResult.className = 'result-message error';
      testConnectionResult.textContent = `Connection Refused: ${result.error}\n\n${result.detail}`;
      showTerminalLog(`SMTP Test Connection Failed: ${result.error}`, 'error');
    }
  } catch (error) {
    testConnectionResult.style.display = 'block';
    testConnectionResult.className = 'result-message error';
    testConnectionResult.textContent = `Network Timeout: Failed to reach backend router. Details: ${error.message}`;
  } finally {
    testConnectionBtn.disabled = false;
    testConnectionBtn.innerHTML = '<i data-lucide="send"></i> Test Configuration';
    lucide.createIcons();
  }
});

/* ==========================================================================
   Campaign Actions: Start, Pause, Reset, Save Draft
   ========================================================================== */
const saveDraftBtn = document.getElementById('save-draft-btn');

saveDraftBtn.addEventListener('click', async () => {
  const subject = subjectInput.value.trim();
  const body = bodyInput.value;
  const selectedDays = Array.from(document.querySelectorAll('input[name="schedule-day"]:checked')).map(el => parseInt(el.value));
  
  saveDraftBtn.disabled = true;
  
  try {
    const response = await fetch('/api/campaign/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: selectedDate,
        subject,
        body,
        scheduleEnabled: document.getElementById('schedule-enabled').checked,
        scheduleTime: document.getElementById('schedule-time').value,
        scheduleAllowedStart: document.getElementById('schedule-allowed-start').value,
        scheduleAllowedEnd: document.getElementById('schedule-allowed-end').value,
        scheduleDays: selectedDays
      })
    });
    
    if (response.ok) {
      showTerminalLog('Campaign draft and scheduling options saved successfully.', 'success');
      alert('Campaign draft saved!');
      await fetchStatus();
    } else {
      const err = await response.json();
      showTerminalLog(`Save Draft Failed: ${err.error}`, 'error');
      alert(err.error);
    }
  } catch (error) {
    showTerminalLog(`Failed to save draft: ${error.message}`, 'error');
  } finally {
    saveDraftBtn.disabled = false;
  }
});

startBtn.addEventListener('click', async () => {
  const subject = subjectInput.value.trim();
  const body = bodyInput.value;
  
  if (!subject) {
    alert('Please enter an email Subject.');
    subjectInput.focus();
    return;
  }
  if (!body) {
    alert('Please enter your email Body text content.');
    bodyInput.focus();
    return;
  }
  
  const selectedDays = Array.from(document.querySelectorAll('input[name="schedule-day"]:checked')).map(el => parseInt(el.value));
  startBtn.disabled = true;
  
  try {
    const response = await fetch('/api/campaign/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: selectedDate,
        subject,
        body,
        scheduleEnabled: document.getElementById('schedule-enabled').checked,
        scheduleTime: document.getElementById('schedule-time').value,
        scheduleAllowedStart: document.getElementById('schedule-allowed-start').value,
        scheduleAllowedEnd: document.getElementById('schedule-allowed-end').value,
        scheduleDays: selectedDays
      })
    });
    
    if (response.ok) {
      showTerminalLog('Campaign start/resume command processed.', 'info');
      await fetchStatus();
    } else {
      const err = await response.json();
      showTerminalLog(`Start Command Failed: ${err.error}`, 'error');
      alert(err.error);
    }
  } catch (error) {
    showTerminalLog(`Failed to start campaign: ${error.message}`, 'error');
  } finally {
    startBtn.disabled = false;
  }
});

pauseBtn.addEventListener('click', async () => {
  pauseBtn.disabled = true;
  try {
    const response = await fetch('/api/campaign/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: selectedDate })
    });
    if (response.ok) {
      showTerminalLog('Campaign pause command processed.', 'info');
      await fetchStatus();
    }
  } catch (error) {
    showTerminalLog(`Failed to pause: ${error.message}`, 'error');
  } finally {
    pauseBtn.disabled = false;
  }
});

resetBtn.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to reset current campaign progress and stats? This resets all statuses to PENDING.')) {
    return;
  }
  resetBtn.disabled = true;
  try {
    const response = await fetch('/api/campaign/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: selectedDate })
    });
    if (response.ok) {
      showTerminalLog('Campaign configuration and progress values reset.', 'info');
      await fetchStatus();
    }
  } catch (error) {
    showTerminalLog(`Failed to reset: ${error.message}`, 'error');
  } finally {
    resetBtn.disabled = false;
  }
});

function resetCampaignState() {
  fileReferenceCleared = true;
  dropZone.style.display = 'flex';
  fileInfo.style.display = 'none';
  fileInput.value = '';
  showTerminalLog('Excel sheet reference cleared in UI. Active queue details in database are kept.', 'info');
}

/* ==========================================================================
   Real-Time Polling & Dashboard Sync UI Helpers
   ========================================================================== */
async function fetchStatus() {
  try {
    const url = selectedDate ? `/api/campaign/status?date=${selectedDate}` : '/api/campaign/status';
    const response = await fetch(url);
    if (!response.ok) {
      setConnectionStatus(false);
      return;
    }
    
    setConnectionStatus(true);
    const data = await response.json();
    
    const oldStatus = currentStatus;
    currentStatus = data.status;
    
    // If no date is selected, we are in calendar view, so only update global settings/status and skip campaign details
    if (!selectedDate) {
      settingsData = data.settings;
      if (!settingsLoaded) {
        smtpUserInput.value = data.settings.smtpUser || '';
        smtpPassInput.value = data.settings.smtpPass || '';
        intervalSlider.value = data.settings.intervalMinutes || 3;
        const val = parseFloat(intervalSlider.value);
        if (val < 1) {
          intervalReadout.textContent = `Every ${Math.round(val * 60)} seconds`;
        } else {
          intervalReadout.textContent = `Every ${val.toFixed(1)} mins`;
        }
        testEmailTargetInput.value = data.settings.testEmail || '';
        trackingUrlInput.value = data.settings.trackingUrl || '';
        settingsLoaded = true;
      }
      return;
    }
    
    recipientsList = data.campaign.recipients || [];
    logsList = data.campaign.logs || [];
    settingsData = data.settings;
    
    // Sync Settings Panel and campaign scheduling options
    if (!settingsLoaded) {
      smtpUserInput.value = data.settings.smtpUser || '';
      smtpPassInput.value = data.settings.smtpPass || '';
      intervalSlider.value = data.settings.intervalMinutes || 3;
      // Trigger slider reading label update
      const val = parseFloat(intervalSlider.value);
      if (val < 1) {
        intervalReadout.textContent = `Every ${Math.round(val * 60)} seconds`;
      } else {
        intervalReadout.textContent = `Every ${val.toFixed(1)} mins`;
      }
      testEmailTargetInput.value = data.settings.testEmail || '';
      trackingUrlInput.value = data.settings.trackingUrl || '';
      
      document.getElementById('schedule-enabled').checked = !!data.campaign.scheduleEnabled;
      document.getElementById('schedule-time').value = data.campaign.scheduleTime || '09:00';
      document.getElementById('schedule-allowed-start').value = data.campaign.scheduleAllowedStart || '09:00';
      document.getElementById('schedule-allowed-end').value = data.campaign.scheduleAllowedEnd || '18:00';
      
      const allowedDays = data.campaign.scheduleDays || [1, 2, 3, 4, 5];
      document.querySelectorAll('input[name="schedule-day"]').forEach(checkbox => {
        const val = parseInt(checkbox.value);
        checkbox.checked = allowedDays.includes(val);
      });
      
      settingsLoaded = true;
    }
    
    // Sync Campaign Composers (only if inputs are currently empty/unfocused to allow refresh)
    if (!subjectInput.value && document.activeElement !== subjectInput) {
      subjectInput.value = data.campaign.subject || '';
    }
    if (!bodyInput.value && document.activeElement !== bodyInput) {
      bodyInput.value = data.campaign.body || '';
    }
    
    // Update Drag-n-Drop state visually on full status refreshes
    if (recipientsList.length > 0 && !fileReferenceCleared) {
      dropZone.style.display = 'none';
      fileInfo.style.display = 'flex';
      // If we don't have file details, put fallback text
      if (fileNameEl.textContent === 'recipients.xlsx') {
        fileNameEl.textContent = 'Active Queue Sheet';
        fileSizeEl.textContent = `${recipientsList.length} Rows Loaded`;
      }
    } else {
      dropZone.style.display = 'flex';
      fileInfo.style.display = 'none';
    }
    
    // Refresh components
    updateCampaignStatusBadge();
    updateMetrics(data.campaign);
    updateProgressBar(data.campaign);
    updateSchedulerTimer(data.campaign.nextSendTime);
    renderConsoleTerminal();
    renderRecipientsTable();
    
  } catch (error) {
    console.error('Polling error:', error);
    setConnectionStatus(false);
  }
}

function setConnectionStatus(isOnline) {
  if (isOnline) {
    connectionStatusBadge.className = 'status-indicator-badge success';
    connectionStatusBadge.querySelector('.text').textContent = 'Server Online';
    connectionStatusBadge.querySelector('.dot').classList.add('pulse');
  } else {
    connectionStatusBadge.className = 'status-indicator-badge paused';
    connectionStatusBadge.querySelector('.text').textContent = 'Offline';
    connectionStatusBadge.querySelector('.dot').classList.remove('pulse');
  }
}

function updateCampaignStatusBadge() {
  const badge = campaignStatusBadge;
  const text = badge.querySelector('.text');
  
  badge.className = 'status-indicator-badge';
  
  switch(currentStatus) {
    case 'RUNNING':
      badge.classList.add('running');
      text.textContent = 'Running';
      startBtn.disabled = true;
      pauseBtn.disabled = false;
      break;
    case 'PAUSED':
      badge.classList.add('paused');
      text.textContent = 'Paused';
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      break;
    case 'COMPLETED':
      badge.classList.add('success');
      text.textContent = 'Finished';
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      break;
    case 'IDLE':
    default:
      badge.classList.add('idle');
      text.textContent = 'Idle';
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      break;
  }
}

function updateMetrics(campaign) {
  const sent = campaign.sentCount || 0;
  const failed = campaign.failedCount || 0;
  const opened = campaign.openedCount || 0;
  const clicked = campaign.clickedCount || 0;
  const total = campaign.totalCount || 0;
  const pending = Math.max(0, total - sent - failed);
  
  metricSent.textContent = sent;
  metricOpened.textContent = opened;
  metricClicked.textContent = clicked;
  metricPending.textContent = pending;
  metricFailed.textContent = failed;
  
  // Calculate success delivery percentage
  const divisor = sent + failed;
  if (divisor > 0) {
    const rate = ((sent / divisor) * 100).toFixed(0);
    metricRate.textContent = `${rate}%`;
  } else {
    metricRate.textContent = '100%';
  }
}

function updateProgressBar(campaign) {
  const sent = campaign.sentCount || 0;
  const failed = campaign.failedCount || 0;
  const total = campaign.totalCount || 0;
  const processed = sent + failed;
  
  progressText.textContent = `${processed} / ${total} Emails Processed`;
  
  if (total > 0) {
    const percent = Math.min(100, Math.round((processed / total) * 100));
    progressFill.style.width = `${percent}%`;
  } else {
    progressFill.style.width = '0%';
  }
}

let countdownInterval = null;
function updateSchedulerTimer(nextSendTime) {
  if (countdownInterval) clearInterval(countdownInterval);
  
  if (currentStatus !== 'RUNNING' || !nextSendTime) {
    countdownCard.style.display = 'none';
    return;
  }
  
  countdownCard.style.display = 'flex';
  
  function refreshCountdown() {
    const now = Date.now();
    const remaining = Math.max(0, Math.round((nextSendTime - now) / 1000));
    
    if (remaining <= 0) {
      countdownText.textContent = 'Deploying next email check...';
      clearInterval(countdownInterval);
      return;
    }
    
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    
    // Pad double digits
    const paddedMinutes = String(minutes).padStart(2, '0');
    const paddedSeconds = String(seconds).padStart(2, '0');
    
    countdownText.textContent = `Next send: ${paddedMinutes}:${paddedSeconds}`;
  }
  
  refreshCountdown();
  countdownInterval = setInterval(refreshCountdown, 1000);
}

/* ==========================================================================
   Console Log Terminal Panel Sync
   ========================================================================== */
function renderConsoleTerminal() {
  // Check if anything changed to avoid refreshing and losing scroll position if it is stable
  const logLines = logsList.map(log => {
    const date = new Date(log.timestamp);
    const timeStr = date.toLocaleTimeString();
    return `<div class="log-line ${log.type}">[${timeStr}] ${escapeHtml(log.message)}</div>`;
  }).reverse().join(''); // Show oldest at top, newest at bottom inside scroll view
  
  const wasScrolledToBottom = consoleTerminal.scrollHeight - consoleTerminal.clientHeight <= consoleTerminal.scrollTop + 10;
  
  if (logsList.length === 0) {
    consoleTerminal.innerHTML = '<div class="log-line system">[SYSTEM] Welcome to Gmail Marketing Console. Logs are updated in real-time.</div>';
  } else {
    consoleTerminal.innerHTML = logLines;
  }
  
  // Auto-scroll to bottom of console if they were already at the bottom
  if (wasScrolledToBottom || consoleTerminal.scrollTop === 0) {
    consoleTerminal.scrollTop = consoleTerminal.scrollHeight;
  }
}

function showTerminalLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.innerHTML = `[${timestamp}] ${escapeHtml(message)}`;
  
  consoleTerminal.appendChild(line);
  consoleTerminal.scrollTop = consoleTerminal.scrollHeight;
}

clearLogsBtn.addEventListener('click', () => {
  consoleTerminal.innerHTML = '<div class="log-line system">[SYSTEM] Console logs view cleared by operator. Local log file campaign.log retains full records.</div>';
});

/* ==========================================================================
   Recipient Queue Data Table Filters and Grid Population
   ========================================================================== */
window.filterQueue = function(filterValue) {
  currentFilter = filterValue;
  currentPage = 1;
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.remove('active');
    if (btn.getAttribute('onclick').includes(filterValue)) {
      btn.classList.add('active');
    }
  });
  renderRecipientsTable();
};

window.handleSearch = function() {
  currentSearch = queueSearchInput.value.toLowerCase().trim();
  currentPage = 1;
  renderRecipientsTable();
};

function renderRecipientsTable() {
  if (recipientsList.length === 0) {
    queueTbody.innerHTML = `
      <tr>
        <td colspan="11" class="table-empty">
          <i data-lucide="users-2"></i>
          <p>No recipient list loaded yet. Upload your Excel/CSV sheet from the Compose tab.</p>
        </td>
      </tr>
    `;
    lucide.createIcons();
    
    // Reset pagination display
    document.getElementById('pagination-start').textContent = '0';
    document.getElementById('pagination-end').textContent = '0';
    document.getElementById('pagination-total').textContent = '0';
    document.getElementById('current-page-display').textContent = 'Page 1 / 1';
    document.getElementById('prev-page-btn').disabled = true;
    document.getElementById('next-page-btn').disabled = true;
    return;
  }
  
  // Apply Search query and tab status filters
  const filtered = recipientsList.filter((recipient, idx) => {
    // Status Filter
    if (currentFilter !== 'all') {
      if (recipient.status.toLowerCase() !== currentFilter) {
        return false;
      }
    }
    
    // Search Query Filter
    if (currentSearch) {
      const name = (recipient.name || '').toLowerCase();
      const email = (recipient.email || '').toLowerCase();
      if (!name.includes(currentSearch) && !email.includes(currentSearch)) {
        return false;
      }
    }
    
    // Attach current database index to maintain integrity
    recipient._origIdx = idx + 1;
    return true;
  });
  
  const totalRecords = filtered.length;
  const totalPages = Math.ceil(totalRecords / pageSize) || 1;
  currentPage = Math.max(1, Math.min(currentPage, totalPages));
  
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalRecords);
  
  // Update pagination indicators
  document.getElementById('pagination-start').textContent = totalRecords > 0 ? startIndex + 1 : 0;
  document.getElementById('pagination-end').textContent = endIndex;
  document.getElementById('pagination-total').textContent = totalRecords;
  document.getElementById('current-page-display').textContent = `Page ${currentPage} / ${totalPages}`;
  document.getElementById('prev-page-btn').disabled = (currentPage === 1);
  document.getElementById('next-page-btn').disabled = (currentPage === totalPages);
  
  if (filtered.length === 0) {
    queueTbody.innerHTML = `
      <tr>
        <td colspan="11" class="table-empty">
          <i data-lucide="search-code"></i>
          <p>No records match your filters or search terms.</p>
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }
  
  const paginated = filtered.slice(startIndex, endIndex);
  
  queueTbody.innerHTML = paginated.map(r => {
    const sentTime = r.sentAt ? new Date(r.sentAt).toLocaleString() : '-';
    const statusLower = r.status.toLowerCase();
    const errorText = r.error ? escapeHtml(r.error) : '-';
    
    // --- Open Tracker Cell ---
    let openCell;
    if (r.opened) {
      const openDt = r.openedAt ? new Date(r.openedAt) : null;
      const openDate = openDt ? openDt.toLocaleDateString(undefined, { day:'2-digit', month:'short', year:'numeric' }) : '';
      const openTime = openDt ? openDt.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '';
      const totalOpens = r.opensCount || 1;
      openCell = `
        <div class="tracker-cell opened">
          <span class="tracker-badge opened">&#128065; Opened</span>
          <span class="tracker-detail">${openDate}</span>
          <span class="tracker-detail">${openTime}</span>
          ${totalOpens > 1 ? `<span class="tracker-count">${totalOpens}x views</span>` : ''}
        </div>`;
    } else {
      openCell = `<div class="tracker-cell"><span class="tracker-badge not-opened">&#128065; Not Opened</span></div>`;
    }
    
    // --- Click Tracker Cell ---
    let clickCell;
    if (r.clicks && r.clicks.length > 0) {
      const clickRows = r.clicks.map((c, i) => {
        const cDt = new Date(c.clickedAt);
        const cDate = cDt.toLocaleDateString(undefined, { day:'2-digit', month:'short' });
        const cTime = cDt.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', second:'2-digit' });
        let urlLabel = c.url;
        try { urlLabel = new URL(c.url).hostname + (new URL(c.url).pathname !== '/' ? new URL(c.url).pathname : ''); } catch(e) {}
        return `<div class="click-row"><span class="click-index">#${i+1}</span><span class="click-url" title="${escapeHtml(c.url)}">${escapeHtml(urlLabel)}</span><span class="click-time">${cDate} ${cTime}</span></div>`;
      }).join('');
      clickCell = `<div class="tracker-cell clicked"><span class="tracker-badge clicked">&#128432; ${r.clicks.length} Click${r.clicks.length > 1 ? 's' : ''}</span><div class="click-list">${clickRows}</div></div>`;
    } else {
      clickCell = `<div class="tracker-cell"><span class="tracker-badge not-clicked">&#128432; No Clicks</span></div>`;
    }
    
    // Dynamically look for Company, City and Client Type fields in uploaded sheet metadata
    let companyVal = '-';
    let cityVal = '-';
    let clientTypeVal = '-';
    if (r.data) {
      const companyKey = Object.keys(r.data).find(k => /company/i.test(k));
      if (companyKey) companyVal = r.data[companyKey] || '-';
      
      const cityKey = Object.keys(r.data).find(k => /city/i.test(k));
      if (cityKey) cityVal = r.data[cityKey] || '-';
      
      const typeKey = Object.keys(r.data).find(k => /type/i.test(k));
      if (typeKey) clientTypeVal = r.data[typeKey] || '-';
    }

    return `
      <tr>
        <td>#${r._origIdx}</td>
        <td><strong>${escapeHtml(r.name)}</strong></td>
        <td>${escapeHtml(r.email)}</td>
        <td>${escapeHtml(companyVal)}</td>
        <td>${escapeHtml(cityVal)}</td>
        <td>${escapeHtml(clientTypeVal)}</td>
        <td>
          <span class="badge-status ${statusLower}">
            ${statusLower}
          </span>
        </td>
        <td>${openCell}</td>
        <td>${clickCell}</td>
        <td>${sentTime}</td>
        <td class="error-cell" title="${errorText}">${errorText}</td>
      </tr>
    `;
  }).join('');
}

window.changePageSize = function() {
  const select = document.getElementById('page-size-select');
  if (select) {
    pageSize = parseInt(select.value) || 25;
    currentPage = 1;
    renderRecipientsTable();
  }
};

window.prevPage = function() {
  if (currentPage > 1) {
    currentPage--;
    renderRecipientsTable();
  }
};

window.nextPage = function() {
  const totalRecords = recipientsList.filter(recipient => {
    if (currentFilter !== 'all' && recipient.status.toLowerCase() !== currentFilter) return false;
    if (currentSearch) {
      const name = (recipient.name || '').toLowerCase();
      const email = (recipient.email || '').toLowerCase();
      if (!name.includes(currentSearch) && !email.includes(currentSearch)) return false;
    }
    return true;
  }).length;
  
  const totalPages = Math.ceil(totalRecords / pageSize) || 1;
  if (currentPage < totalPages) {
    currentPage++;
    renderRecipientsTable();
  }
};

/* ==========================================================================
   Utilities
   ========================================================================== */
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}

/* ==========================================================================
   Campaign History and CSV Exports Handler
   ========================================================================== */
window.exportCurrentCampaign = function() {
  const modal = document.getElementById('export-modal');
  if (modal) {
    modal.classList.add('active');
    
    // Reset dates
    document.getElementById('export-start-date').value = '';
    document.getElementById('export-end-date').value = '';

    // Collect all unique client types, companies, cities from recipientsList
    const clientTypes = new Set();
    const companies = new Set();
    const cities = new Set();

    recipientsList.forEach(r => {
      if (r.data) {
        // Look for keys containing "type", "company", "city"
        const typeKey = Object.keys(r.data).find(k => /type/i.test(k));
        if (typeKey && r.data[typeKey]) {
          const val = r.data[typeKey].trim();
          if (val) clientTypes.add(val);
        }

        const companyKey = Object.keys(r.data).find(k => /company/i.test(k));
        if (companyKey && r.data[companyKey]) {
          const val = r.data[companyKey].trim();
          if (val) companies.add(val);
        }

        const cityKey = Object.keys(r.data).find(k => /city/i.test(k));
        if (cityKey && r.data[cityKey]) {
          const val = r.data[cityKey].trim();
          if (val) cities.add(val);
        }
      }
    });

    // Helper to populate select options
    const populateSelect = (elementId, valuesSet, placeholderText) => {
      const select = document.getElementById(elementId);
      if (!select) return;

      let html = `<option value="">-- ${placeholderText} --</option>`;
      Array.from(valuesSet).sort().forEach(val => {
        html += `<option value="${escapeHtml(val)}">${escapeHtml(val)}</option>`;
      });
      select.innerHTML = html;
    };

    populateSelect('export-client-type', clientTypes, 'All Client Types');
    populateSelect('export-company', companies, 'All Companies');
    populateSelect('export-city', cities, 'All Cities');
  }
};

window.closeExportModal = function() {
  const modal = document.getElementById('export-modal');
  if (modal) modal.classList.remove('active');
};

window.submitExport = async function() {
  const startDate = document.getElementById('export-start-date').value;
  const endDate = document.getElementById('export-end-date').value;
  const clientType = document.getElementById('export-client-type').value;
  const company = document.getElementById('export-company').value;
  const city = document.getElementById('export-city').value;
  
  const params = new URLSearchParams();
  if (selectedDate) params.append('date', selectedDate);
  if (startDate) params.append('startDate', startDate);
  if (endDate) params.append('endDate', endDate);
  if (clientType) params.append('clientType', clientType);
  if (company) params.append('company', company);
  if (city) params.append('city', city);
  
  const submitBtn = document.querySelector('.modal-footer .btn.primary-gradient');
  const originalText = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="spin-icon" data-lucide="loader"></i> Exporting...';
  lucide.createIcons();

  try {
    const url = `/api/campaign/export?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      const errorMsg = await response.text();
      alert(`Export Failed: ${errorMsg}`);
      return;
    }
    
    // Trigger download
    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    
    // Get filename from header if possible
    const disposition = response.headers.get('content-disposition');
    let filename = 'campaign_report.csv';
    if (disposition && disposition.indexOf('attachment') !== -1) {
      const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
      const matches = filenameRegex.exec(disposition);
      if (matches != null && matches[1]) { 
        filename = matches[1].replace(/['"]/g, '');
      }
    }
    
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(downloadUrl);
    
    closeExportModal();
  } catch (error) {
    alert(`Network Error: ${error.message}`);
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
    lucide.createIcons();
  }
};

window.clearCampaignQueue = async function() {
  if (!confirm('Are you sure you want to completely clear the active recipient queue? This will permanently delete all records from the current queue.')) {
    return;
  }
  try {
    const response = await fetch('/api/campaign/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: selectedDate })
    });
    if (response.ok) {
      fileReferenceCleared = false;
      showTerminalLog('Active recipient queue completely cleared from the database.', 'info');
      await fetchStatus();
    }
  } catch (error) {
    showTerminalLog(`Error clearing queue: ${error.message}`, 'error');
  }
};

window.exportHistoryRun = function(runId) {
  window.location.href = `/api/history/export/${runId}`;
};

window.loadHistory = async function() {
  const tableBody = document.getElementById('history-table-body');
  try {
    const res = await fetch('/api/history');
    if (!res.ok) throw new Error('Failed to fetch history');
    const runs = await res.json();
    
    // Aggregation of total metrics across all runs
    let totalDelivered = 0;
    let totalOpened = 0;
    let totalClicked = 0;
    let totalFailed = 0;
    let totalPending = 0;
    
    runs.forEach(run => {
      totalDelivered += (run.sentCount || 0);
      totalOpened += (run.openedCount || 0);
      totalClicked += (run.clickedCount || 0);
      totalFailed += (run.failedCount || 0);
      totalPending += Math.max(0, (run.totalCount || 0) - (run.sentCount || 0) - (run.failedCount || 0));
    });
    
    const divisor = totalDelivered + totalFailed;
    const successRate = divisor > 0 ? ((totalDelivered / divisor) * 100).toFixed(0) : '100';
    
    document.getElementById('history-metric-sent').textContent = totalDelivered;
    document.getElementById('history-metric-opened').textContent = totalOpened;
    document.getElementById('history-metric-clicked').textContent = totalClicked;
    document.getElementById('history-metric-failed').textContent = totalFailed;
    document.getElementById('history-metric-pending').textContent = totalPending;
    document.getElementById('history-metric-rate').textContent = `${successRate}%`;
    
    if (runs.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; padding: 2rem; color: var(--text-muted);">
            No campaign runs recorded yet.
          </td>
        </tr>
      `;
      return;
    }
    
    tableBody.innerHTML = runs.map(run => {
      const date = new Date(run.timestamp).toLocaleString();
      return `
        <tr>
          <td style="font-weight: 500; color: var(--text-primary);">${date}</td>
          <td title="${escapeHtml(run.subject)}">
            <div style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              ${escapeHtml(run.subject) || '<span style="color: var(--text-muted); font-style: italic;">No Subject</span>'}
            </div>
          </td>
          <td>${run.totalCount}</td>
          <td><span style="color: var(--color-success); font-weight: 600;">${run.sentCount}</span></td>
          <td><span style="color: var(--color-danger); font-weight: 600;">${run.failedCount}</span></td>
          <td><span style="color: var(--color-primary); font-weight: 600;">${run.openedCount}</span></td>
          <td><span style="color: var(--color-cyan); font-weight: 600;">${run.clickedCount}</span></td>
          <td style="text-align: center;">
            <button class="btn secondary" style="padding: 4px 8px; font-size: 0.8rem; height: 26px; display: inline-flex; align-items: center; gap: 4px;" onclick="exportHistoryRun('${run.runId}')">
              <i data-lucide="download" style="width: 12px; height: 12px;"></i> Export Report
            </button>
          </td>
        </tr>
      `;
    }).join('');
    
    // Refresh icons inside dynamic rows
    if (window.lucide) {
      lucide.createIcons();
    }
  } catch (error) {
    console.error('History fetch error:', error);
    tableBody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; padding: 2rem; color: var(--color-danger);">
          Failed to load campaign runs: ${error.message}
        </td>
      </tr>
    `;
  }
};

// Initial System Boots
(async () => {
  await fetchStatus();
  if (document.getElementById('tab-composer').classList.contains('active') && !selectedDate) {
    await fetchCalendarCampaigns();
  }
  // Set up periodic polling refresh
  setInterval(async () => {
    await fetchStatus();
    if (document.getElementById('tab-composer').classList.contains('active') && !selectedDate) {
      await fetchCalendarCampaigns();
    }
  }, 3000);
})();

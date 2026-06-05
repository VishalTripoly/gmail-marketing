const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');

async function checkBouncesForUser(user, db, saveDatabase, addCampaignLog, HISTORY_DIR) {
  if (!user.settings || !user.settings.smtpUser || !user.settings.smtpPass) {
    return;
  }
  
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: user.settings.smtpUser,
      pass: user.settings.smtpPass
    },
    logger: false
  });
  
  try {
    await client.connect();
    
    let lock = await client.getMailboxLock('INBOX');
    try {
      // Find unread emails
      const messages = await client.search({ seen: false });
      
      for (const item of messages) {
        const uid = item; // search returns list of UIDs or seq numbers depending on source
        let message = await client.fetchOne(uid, { source: true });
        if (!message || !message.source) continue;
        
        let parsed = await simpleParser(message.source);
        
        const from = (parsed.from && parsed.from.text) || '';
        const subject = parsed.subject || '';
        const bodyText = parsed.text || '';
        const bodyHtml = parsed.html || '';
        const fullBody = (bodyText + '\n' + bodyHtml);
        const fullBodyLower = fullBody.toLowerCase();
        
        const isBounceSender = /mailer-daemon|postmaster|daemon/i.test(from);
        const isBounceSubject = /delivery\s+status|undelivered|failure|failed|returned\s+mail|delivery\s+incomplete|delivery\s+problem/i.test(subject);
        
        if (isBounceSender || isBounceSubject) {
          console.log(`[Bounce Parser] Processing potential bounce. From: ${from}, Subject: ${subject}`);
          
          // Match all email addresses in the body
          const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
          const foundEmails = fullBody.match(emailRegex) || [];
          const uniqueFoundEmails = [...new Set(foundEmails.map(e => e.toLowerCase()))];
          
          // Exclude the user's own address and daemon addresses
          const targetEmails = uniqueFoundEmails.filter(email => {
            return email !== user.settings.smtpUser.toLowerCase() && 
                   !/mailer-daemon|postmaster|daemon|googlemail/i.test(email);
          });
          
          if (targetEmails.length > 0) {
            // Determine failure reason
            let errorReason = 'Email Delivery Failed (Bounce)';
            if (/inbox is full|inbox\s+full|quota|space/i.test(fullBodyLower)) {
              errorReason = 'Recipient inbox full';
            } else if (/address couldn't be found|address\s+not\s+found|no\s+such\s+user|does\s+not\s+exist|recipient\s+rejected|invalid\s+recipient/i.test(fullBodyLower)) {
              errorReason = 'Address not found';
            } else if (/temporary\s+problem|delivery\s+incomplete|retry\s+for/i.test(fullBodyLower)) {
              errorReason = 'Delivery incomplete (Temporary)';
            } else {
              // Fallback: extract context snippet around the first matched target email
              const targetEmail = targetEmails[0];
              const idx = fullBodyLower.indexOf(targetEmail);
              if (idx !== -1) {
                const snippet = fullBody.substring(Math.max(0, idx - 40), Math.min(fullBody.length, idx + 160));
                const cleaned = snippet.replace(/[\r\n]+/g, ' ').trim();
                errorReason = 'Bounce: ' + (cleaned.length > 120 ? cleaned.substring(0, 117) + '...' : cleaned);
              }
            }
            
            let updatedCount = 0;
            if (user.campaigns) {
              for (const dateStr of Object.keys(user.campaigns)) {
                const campaign = user.campaigns[dateStr];
                if (!campaign.recipients) continue;
                
                campaign.recipients.forEach(r => {
                  if (targetEmails.includes(r.email.toLowerCase())) {
                    if (r.status !== 'FAILED') {
                      const oldStatus = r.status;
                      r.status = 'FAILED';
                      r.error = errorReason;
                      
                      campaign.failedCount = (campaign.failedCount || 0) + 1;
                      if (oldStatus === 'SENT') {
                        campaign.sentCount = Math.max(0, (campaign.sentCount || 0) - 1);
                      }
                      
                      updatedCount++;
                      addCampaignLog(user, campaign, `⚠️ Delivery failure detected for ${r.name} <${r.email}>: ${errorReason}`, 'error');
                    }
                  }
                });
              }
            }
            
            // Also update history run JSON files
            try {
              const userHistoryDir = path.join(HISTORY_DIR, user.id);
              if (fs.existsSync(userHistoryDir)) {
                const files = fs.readdirSync(userHistoryDir).filter(f => f.endsWith('.json'));
                for (const file of files) {
                  const runFilePath = path.join(userHistoryDir, file);
                  const runData = JSON.parse(fs.readFileSync(runFilePath, 'utf8'));
                  let runUpdated = false;
                  
                  if (runData.recipients) {
                    runData.recipients.forEach(r => {
                      if (targetEmails.includes(r.email.toLowerCase())) {
                        if (r.status !== 'FAILED') {
                          const oldStatus = r.status;
                          r.status = 'FAILED';
                          r.error = errorReason;
                          runData.failedCount = (runData.failedCount || 0) + 1;
                          if (oldStatus === 'SENT') {
                            runData.sentCount = Math.max(0, (runData.sentCount || 0) - 1);
                          }
                          runUpdated = true;
                        }
                      }
                    });
                  }
                  
                  if (runUpdated) {
                    fs.writeFileSync(runFilePath, JSON.stringify(runData, null, 2), 'utf8');
                    console.log(`[Bounce Parser] Updated history file: ${file}`);
                  }
                }
              }
            } catch (historyErr) {
              console.error(`[Bounce Parser] Error updating history files:`, historyErr);
            }
            
            if (updatedCount > 0) {
              saveDatabase();
            }
          }
          
          // Mark as read
          await client.messageFlagsAdd({ uid }, ['\\Seen']);
        }
      }
    } finally {
      lock.release();
    }
    
    await client.logout();
  } catch (err) {
    console.error(`[Bounce Parser] Error checking bounces for ${user.email}:`, err.message);
  }
}

module.exports = {
  checkBouncesForUser
};

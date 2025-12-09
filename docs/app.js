(function() {
  'use strict';

  // Format time from ISO string like "2025-12-08T00:00:00+02:00"
  function formatTime(isoString) {
    const match = isoString.match(/T(\d{2}):(\d{2})/);
    if (!match) return isoString;
    return match[1] + ':' + match[2];
  }

  // Format updated timestamp in user's timezone
  function formatUpdatedTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const formatted = date.toLocaleString('uk-UA', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    return ` | <strong>Оновлено:</strong> ${formatted}`;
  }

  // Render groups from data
  function renderGroups(data) {
    const container = document.getElementById('groups-container');
    if (!container) return;

    const groups = Object.keys(data.groups).sort();
    
    if (groups.length === 0) {
      container.innerHTML = '<div class="loading">Немає даних про відключення</div>';
      return;
    }

    container.innerHTML = groups.map(groupId => {
      const intervals = data.groups[groupId];
      const intervalsHtml = intervals.length > 0 
        ? `<div class="intervals">${intervals.map(interval => 
            `<div class="interval-item" data-start="${interval.start}" data-end="${interval.end}">${formatTime(interval.start)} — ${formatTime(interval.end)}</div>`
          ).join('')}</div>`
        : '<div class="intervals"><div class="interval-item">Електроенергія є.</div></div>';
      
      return `<div class="group-card">
        <div class="group-title">Група ${groupId}</div>
        ${intervalsHtml}
        <div class="group-links">
          <a href="#" class="link copy-link" data-ics-path="cal/${groupId}.ics">Скопіювати посилання</a>
        </div>
      </div>`;
    }).join('\n');

    // Set schedule date attribute
    container.setAttribute('data-schedule-date', data.date);
  }

  // Update interval states (past/current/future)
  function updateIntervals() {
    const now = new Date();
    const currentTime = now.getTime();
    const intervalItems = document.querySelectorAll('.interval-item');
    const groupCards = document.querySelectorAll('.group-card');
    
    // Reset group cards
    groupCards.forEach(card => {
      card.classList.remove('has-current');
    });
    
    intervalItems.forEach(item => {
      const startStr = item.getAttribute('data-start');
      const endStr = item.getAttribute('data-end');
      
      if (!startStr || !endStr) return;
      
      const startTime = new Date(startStr).getTime();
      const endTime = new Date(endStr).getTime();
      
      if (isNaN(startTime) || isNaN(endTime)) return;
      
      item.classList.remove('past', 'current');
      
      if (currentTime < startTime) {
        // Future period - no special styling
      } else if (currentTime >= startTime && currentTime < endTime) {
        // Current period
        item.classList.add('current');
        const groupCard = item.closest('.group-card');
        if (groupCard) {
          groupCard.classList.add('has-current');
        }
      } else {
        // Past period
        item.classList.add('past');
      }
    });
  }

  // Copy link functionality
  function setupCopyLinks() {
    const copyLinks = document.querySelectorAll('.copy-link');
    copyLinks.forEach(link => {
      link.addEventListener('click', async function(e) {
        e.preventDefault();
        const icsPath = this.getAttribute('data-ics-path');
        const fullUrl = new URL(icsPath, window.location.href).href;
        
        try {
          await navigator.clipboard.writeText(fullUrl);
          const originalText = this.textContent;
          this.textContent = '✓ Скопійовано!';
          this.classList.add('copied');
          
          // Track calendar copy link event
          if (typeof gtag !== 'undefined') {
            const groupId = this.getAttribute('data-ics-path').replace('cal/', '').replace('.ics', '');
            gtag('event', 'calendar_copy_link', {
              'event_category': 'engagement',
              'event_label': groupId,
              'value': 1
            });
          }
          
          setTimeout(() => {
            this.textContent = originalText;
            this.classList.remove('copied');
          }, 2000);
        } catch (err) {
          // Fallback for older browsers
          const textArea = document.createElement('textarea');
          textArea.value = fullUrl;
          textArea.style.position = 'fixed';
          textArea.style.opacity = '0';
          document.body.appendChild(textArea);
          textArea.select();
          try {
            document.execCommand('copy');
            const originalText = this.textContent;
            this.textContent = '✓ Скопійовано!';
            this.classList.add('copied');
            
            // Track calendar copy link event
            if (typeof gtag !== 'undefined') {
              const groupId = this.getAttribute('data-ics-path').replace('cal/', '').replace('.ics', '');
              gtag('event', 'calendar_copy_link', {
                'event_category': 'engagement',
                'event_label': groupId,
                'value': 1
              });
            }
            
            setTimeout(() => {
              this.textContent = originalText;
              this.classList.remove('copied');
            }, 2000);
          } catch (e) {
            alert('Не вдалося скопіювати посилання');
          }
          document.body.removeChild(textArea);
        }
      });
    });
  }

  // Load data and render
  async function loadData() {
    // Check if running locally (file:// protocol)
    if (window.location.protocol === 'file:') {
      const container = document.getElementById('groups-container');
      if (container) {
        container.innerHTML = `
          <div class="loading" style="text-align: left; padding: 1rem;">
            <strong>Локальне тестування:</strong><br><br>
            Браузери блокують завантаження файлів через протокол <code>file://</code>.<br><br>
            Для локального тестування запустіть локальний сервер:<br><br>
            <code style="background: #f0f0f0; padding: 0.25rem 0.5rem; border-radius: 3px;">
              python3 -m http.server 8000
            </code><br><br>
            або<br><br>
            <code style="background: #f0f0f0; padding: 0.25rem 0.5rem; border-radius: 3px;">
              npx serve
            </code><br><br>
            Потім відкрийте <code>http://localhost:8000</code> у браузері.
          </div>
        `;
      }
      return;
    }

    try {
      const response = await fetch('data/latest.json');
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      
      // Update header
      const scheduleDateEl = document.getElementById('schedule-date');
      if (scheduleDateEl) {
        scheduleDateEl.textContent = data.date;
      }
      
      const updatedTimeContainer = document.getElementById('updated-time-container');
      if (updatedTimeContainer) {
        updatedTimeContainer.innerHTML = formatUpdatedTime(data.updated_at);
      }
      
      // Render groups
      renderGroups(data);
      
      // Setup interval updates
      updateIntervals();
      setInterval(updateIntervals, 60000);
      
      // Setup copy links
      setupCopyLinks();
    } catch (error) {
      console.error('Error loading data:', error);
      const container = document.getElementById('groups-container');
      if (container) {
        container.innerHTML = '<div class="loading">Помилка завантаження даних. Спробуйте оновити сторінку.</div>';
      }
    }
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadData);
  } else {
    loadData();
  }
})();


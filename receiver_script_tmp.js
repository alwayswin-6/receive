
      const deviceGrid = document.getElementById('deviceGrid');
      const meta = document.getElementById('meta');
      let expandedDeviceId = null;
      let lastPayload = null;

      function escapeHtml(value) {
        return String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\"/g, '&quot;');
      }

      function renderDevices(devices) {
        if (!devices.length) {
          if (!deviceGrid.querySelector('.empty-state')) {
            deviceGrid.innerHTML = '<div class="empty-state">No WebRTC screens have been received yet.</div>';
          }
          return;
        }

        const emptyState = deviceGrid.querySelector('.empty-state');
        if (emptyState) {
          emptyState.remove();
        }

        const existingCards = new Map(
          Array.from(deviceGrid.querySelectorAll('.device-card')).map((card) => [card.dataset.deviceId, card])
        );
        let previousCard = null;

        devices.forEach((device) => {
          const deviceId = device.device_id || device.safe_device_id || 'unknown';
          const title = device.device_id || device.safe_device_id || 'Unknown device';
          const timestamp = device.timestamp || 'Unknown time';
          const source = device.source || 'unknown';
          const signal = device.signal || device.webrtc || {};
          const signalType = signal.type || device.type || 'offer';
          const sdpText = (signal.sdp || '').slice(0, 80);
          const isExpanded = expandedDeviceId === deviceId;

          let card = existingCards.get(deviceId);
          if (!card) {
            card = document.createElement('button');
            card.type = 'button';
            card.className = 'device-card';
            card.dataset.deviceId = deviceId;

            const imgWrap = document.createElement('div');
            imgWrap.className = 'card-image-wrap';
            const signalPreview = document.createElement('pre');
            signalPreview.className = 'signal-preview';
            signalPreview.style.cssText = 'white-space:pre-wrap;overflow:auto;width:100%;height:100%;margin:0;padding:12px;line-height:1.45;font-size:0.74rem;color:#c9d1d9;';
            imgWrap.appendChild(signalPreview);
            card.appendChild(imgWrap);

            const titleEl = document.createElement('div');
            titleEl.className = 'title';
            card.appendChild(titleEl);
            const detailA = document.createElement('div');
            detailA.className = 'detail';
            card.appendChild(detailA);
            const detailB = document.createElement('div');
            detailB.className = 'detail';
            card.appendChild(detailB);
          }

          card.className = 'device-card' + (isExpanded ? ' expanded' : '');
          card.dataset.deviceId = deviceId;

          const signalPreview = card.querySelector('pre.signal-preview');
          if (signalPreview) {
            signalPreview.textContent = `${signalType}\n${sdpText}`;
          }

          const titleEl = card.querySelector('.title');
          const detailEls = card.querySelectorAll('.detail');
          if (titleEl) titleEl.textContent = title;
          if (detailEls[0]) detailEls[0].textContent = timestamp;
          if (detailEls[1]) detailEls[1].textContent = `${source} • ${signalType}`;

          if (previousCard) {
            if (previousCard.nextSibling !== card) {
              deviceGrid.insertBefore(card, previousCard.nextSibling);
            }
          } else if (deviceGrid.firstChild !== card) {
            deviceGrid.insertBefore(card, deviceGrid.firstChild);
          }

          previousCard = card;
          existingCards.delete(deviceId);
        });

        existingCards.forEach((card) => card.remove());
      }

      function toggleExpanded(deviceId) {
        if (expandedDeviceId === deviceId) {
          expandedDeviceId = null;
        } else {
          expandedDeviceId = deviceId;
        }
        renderDevices(lastPayload?.devices || []);
      }

      let pollInProgress = false;
      const POLL_INTERVAL_MS = 500;
      let lastUpdateKey = '';

      function buildUpdateKey(devices) {
        if (!devices || !devices.length) {
          return '';
        }
        return devices
          .map((device) => `${device.device_id || device.safe_device_id || 'unknown'}:${device.timestamp || ''}`)
          .join('|');
      }

      async function postWebRtcSignal(payload) {
        try {
          const response = await fetch('/webrtc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!response.ok) {
            throw new Error(`WebRTC signal error ${response.status}`);
          }
          return await response.json();
        } catch (error) {
          console.error(error);
          return null;
        }
      }

      function createDemoWebRtcOffer(deviceId) {
        return {
          type: 'offer',
          sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n',
          device_id: deviceId,
          user: { device_id: deviceId },
          source: 'webrtc-browser-signal',
          created_at: new Date().toISOString(),
        };
      }

      async function pollOnce() {
        if (pollInProgress) {
          return;
        }
        pollInProgress = true;
        try {
          const response = await fetch(`/webrtc`, { cache: 'no-store' });
          if (!response.ok) {
            throw new Error(`Status ${response.status}`);
          }

          const data = await response.json();
          const devices = data.devices || [];
          const updateKey = buildUpdateKey(devices);
          if (updateKey !== lastUpdateKey) {
            lastUpdateKey = updateKey;
            lastPayload = data;
            renderDevices(devices);
          }

          if (devices.length) {
            const latest = devices[devices.length - 1];
            meta.textContent = `${devices.length} WebRTC device${devices.length === 1 ? '' : 's'} connected • Last update: ${latest.timestamp || 'n/a'}`;
          } else {
            meta.textContent = 'Waiting for WebRTC signals...';
          }
        } catch (error) {
          meta.textContent = `Waiting for WebRTC signals... ${error.message}`;
        } finally {
          pollInProgress = false;
        }
      }

      function startPolling() {
        pollOnce();
        setInterval(pollOnce, POLL_INTERVAL_MS);
      }

      deviceGrid.addEventListener('click', (event) => {
        const card = event.target.closest('.device-card');
        if (!card) {
          return;
        }
        toggleExpanded(card.dataset.deviceId);
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          expandedDeviceId = null;
          renderDevices(lastPayload?.devices || []);
        }
      });

      const demoDeviceId = 'demo-webrtc-device';
      postWebRtcSignal(createDemoWebRtcOffer(demoDeviceId));

      startPolling();
    
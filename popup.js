document.addEventListener('DOMContentLoaded', async () => {
    const serverAddressInput = document.getElementById('serverAddress');
    const buttonPositionSelect = document.getElementById('buttonPosition');
    const offsetXInput = document.getElementById('offsetX');
    const offsetYInput = document.getElementById('offsetY');
    const minImgSizeInput = document.getElementById('minImgSize');
    const workflowSelect = document.getElementById('workflowSelect');
    const addWorkflowBtn = document.getElementById('addWorkflowBtn');
    const delWorkflowBtn = document.getElementById('delWorkflowBtn');
    
    const workflowNameInput = document.getElementById('workflowName');
    const executionModeSelect = document.getElementById('executionMode');
    const targetNodeTypeInput = document.getElementById('targetNodeType');
    
    const targetNodeIdInput = document.getElementById('targetNodeId');
    const workflowJsonInput = document.getElementById('workflowJson');
    
    const frontendConfig = document.getElementById('frontendConfig');
    const apiConfig = document.getElementById('apiConfig');
    
    const saveBtn = document.getElementById('saveBtn');
    const saveStatus = document.getElementById('saveStatus');

    const siteEnableToggle = document.getElementById('siteEnableToggle');
    const siteEnableLabel = document.getElementById('siteEnableLabel');
    let currentHostname = '';

    let config = {
        serverAddress: 'http://127.0.0.1:8188',
        buttonPosition: 'top-right',
        offsetX: 0,
        offsetY: 0,
        minImgSize: 200,
        activeProfileId: 'default',
        disabledHosts: [],
        profiles: {
            'default': {
                name: '默认前端注入',
                mode: 'frontend',
                targetNodeType: '',
                targetNodeId: '',
                workflowJson: ''
            }
        }
    };

    // Load from storage
    const data = await chrome.storage.local.get(['comfyConfig']);
    if (data.comfyConfig) {
        // Merge with defaults
        config = { ...config, ...data.comfyConfig };
        if (!config.profiles) {
            config.profiles = { 'default': { name: '默认前端注入', mode: 'frontend', targetNodeType: '' } };
            config.activeProfileId = 'default';
        }
        if (!config.disabledHosts) {
            config.disabledHosts = [];
        }
    }

    serverAddressInput.value = config.serverAddress || 'http://127.0.0.1:8188';
    buttonPositionSelect.value = config.buttonPosition || 'top-right';
    offsetXInput.value = config.offsetX || 0;
    offsetYInput.value = config.offsetY || 0;
    minImgSizeInput.value = config.minImgSize !== undefined ? config.minImgSize : 200;

    // Get current tab info and update site enable toggle
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (tabs && tabs[0] && tabs[0].url) {
            try {
                let url = new URL(tabs[0].url);
                if (url.protocol.startsWith('http')) {
                    currentHostname = url.hostname;
                    siteEnableLabel.textContent = `在此网站启用插件 (${currentHostname})`;
                    siteEnableToggle.checked = !config.disabledHosts.includes(currentHostname);
                } else {
                    siteEnableToggle.disabled = true;
                    siteEnableLabel.textContent = `当前页面无法禁用插件`;
                    siteEnableToggle.checked = false;
                }
            } catch(e) {
                siteEnableToggle.disabled = true;
                siteEnableLabel.textContent = `无法识别当前网站`;
            }
        }
    });

    function renderProfiles() {
        workflowSelect.innerHTML = '';
        for (const [id, profile] of Object.entries(config.profiles)) {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = profile.name || '未命名工作流';
            workflowSelect.appendChild(option);
        }
        if (!config.profiles[config.activeProfileId]) {
            config.activeProfileId = Object.keys(config.profiles)[0];
        }
        workflowSelect.value = config.activeProfileId;
        loadProfileData(config.activeProfileId);
    }

    function loadProfileData(profileId) {
        const profile = config.profiles[profileId];
        if (!profile) return;
        workflowNameInput.value = profile.name || '';
        executionModeSelect.value = profile.mode || 'frontend';
        targetNodeTypeInput.value = profile.targetNodeType || '';
        targetNodeIdInput.value = profile.targetNodeId || '';
        workflowJsonInput.value = profile.workflowJson || '';
        
        updateModeUI();
    }

    function saveCurrentProfileData() {
        const id = workflowSelect.value;
        if (!id || !config.profiles[id]) return;
        config.profiles[id].name = workflowNameInput.value;
        config.profiles[id].mode = executionModeSelect.value;
        config.profiles[id].targetNodeType = targetNodeTypeInput.value;
        config.profiles[id].targetNodeId = targetNodeIdInput.value;
        config.profiles[id].workflowJson = workflowJsonInput.value;

        // Update option text
        const option = workflowSelect.querySelector(`option[value="${id}"]`);
        if (option) {
            option.textContent = workflowNameInput.value || '未命名工作流';
        }
    }

    function updateModeUI() {
        if (executionModeSelect.value === 'api') {
            frontendConfig.style.display = 'none';
            apiConfig.style.display = 'block';
        } else {
            frontendConfig.style.display = 'block';
            apiConfig.style.display = 'none';
        }
    }

    executionModeSelect.addEventListener('change', updateModeUI);

    workflowSelect.addEventListener('change', (e) => {
        config.activeProfileId = e.target.value;
        loadProfileData(config.activeProfileId);
    });

    // To ensure data is saved when switching
    workflowSelect.addEventListener('mousedown', saveCurrentProfileData);

    addWorkflowBtn.addEventListener('click', () => {
        saveCurrentProfileData();
        const newId = 'profile_' + Date.now();
        config.profiles[newId] = {
            name: '新工作流 ' + (Object.keys(config.profiles).length + 1),
            mode: 'frontend',
            targetNodeType: '',
            targetNodeId: '',
            workflowJson: ''
        };
        config.activeProfileId = newId;
        renderProfiles();
    });

    delWorkflowBtn.addEventListener('click', () => {
        const ids = Object.keys(config.profiles);
        if (ids.length <= 1) {
            alert('至少需要保留一个配置方案哦！');
            return;
        }
        if (confirm('确认删除当前配置吗？')) {
            delete config.profiles[config.activeProfileId];
            config.activeProfileId = Object.keys(config.profiles)[0];
            renderProfiles();
        }
    });

    saveBtn.addEventListener('click', async () => {
        saveCurrentProfileData();
        config.serverAddress = serverAddressInput.value.trim().replace(/\/$/, ""); // remove trailing slash
        config.buttonPosition = buttonPositionSelect.value;
        config.offsetX = parseInt(offsetXInput.value) || 0;
        config.offsetY = parseInt(offsetYInput.value) || 0;
        config.minImgSize = parseInt(minImgSizeInput.value);
        if (isNaN(config.minImgSize)) config.minImgSize = 200;
        
        // 保存网站开关状态
        if (currentHostname) {
            config.disabledHosts = config.disabledHosts || [];
            if (siteEnableToggle.checked) {
                config.disabledHosts = config.disabledHosts.filter(h => h !== currentHostname);
            } else {
                if (!config.disabledHosts.includes(currentHostname)) {
                    config.disabledHosts.push(currentHostname);
                }
            }
        }

        await chrome.storage.local.set({ comfyConfig: config });
        
        saveStatus.style.display = 'inline';
        setTimeout(() => {
            saveStatus.style.display = 'none';
            window.close(); // Close popup after save
        }, 800);
    });

    renderProfiles();
});
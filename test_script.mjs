
        import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
        import { getAuth, onAuthStateChanged, signOut, RecaptchaVerifier, signInWithPhoneNumber, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
        import { getDatabase, ref, set, get, child, onValue, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-database.js";

        const firebaseConfig = window.ATTENI_FIREBASE_CONFIG;
        const appId = window.ATTENI_APP_ID;
        const dbPath = window.ATTENI_DB_PATH;

        const appFB = initializeApp(firebaseConfig);
        const auth = getAuth(appFB);
        const db = getDatabase(appFB);

        // --- GLOBAL ERROR TRACKING ---
        onValue(ref(db, `${dbPath}/system/parentPortalLock`), snap => {
            const isLocked = !!snap.val();
            const overlay = document.getElementById('parentPortalLockOverlay');
            if (overlay) {
                if (isLocked) {
                    overlay.classList.remove('hidden');
                    document.body.style.overflow = 'hidden';
                } else {
                    overlay.classList.add('hidden');
                    document.body.style.overflow = '';
                }
            }
        });
        window.onerror = function(message, source, lineno, colno, error) {
            try {
                const crashId = Date.now();
                const crashRef = ref(db, `artifacts/${appId}/crashes/${crashId}`);
                set(crashRef, {
                    message, source, lineno, colno, error: error ? error.stack : null,
                    page: window.location.pathname,
                    userAgent: navigator.userAgent,
                    time: serverTimestamp()
                });
            } catch(e) {}
            return false;
        };

        let currentUser = null;
        let students = [];
        let selectedStudent = null;
        let trendChartInstance = null;
        let barChartInstance = null;
        let pieChartInstance = null;
        let journeyTimerInterval = null;
        let currentHistoryForPDF = [];
        let cachedJourneyStartTime = null; // Fix: cache startTime so slider changes don't recalculate from markedAt
        let historyStudentId = null; // Fix #7: track which student's history is loaded

        // --- UTILS ---
        const normalizeClassLabel = (val) => {
            const trimmed = String(val || '').trim().toUpperCase();
            if (/^\d+$/.test(trimmed)) {
                let num = parseInt(trimmed, 10);
                const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
                const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
                let res = '';
                for (let i = 0; i < vals.length; i++) {
                    while (num >= vals[i]) { res += syms[i]; num -= vals[i]; }
                }
                return res;
            }
            return trimmed;
        };

        window.fbServerTimeOffset = 0;
        onValue(ref(db, '.info/serverTimeOffset'), snap => {
            window.fbServerTimeOffset = snap.val() || 0;
        });
        const getServerDate = () => new Date(Date.now() + (window.fbServerTimeOffset || 0));

        // Global Toast Logic
        window.showToast = function(msg, type = 'error') {
            const toast = document.getElementById('toastNotification');
            const toastMsg = document.getElementById('toastMsg');
            const toastIcon = document.getElementById('toastIcon');
            
            toastMsg.textContent = msg;
            
            if (type === 'error') {
                toastIcon.textContent = '⚠️';
                toastIcon.className = 'text-red-500 text-lg drop-shadow-sm';
            } else if (type === 'success') {
                toastIcon.textContent = '✅';
                toastIcon.className = 'text-emerald-500 text-lg drop-shadow-sm';
            }
            
            // Slide in
            toast.classList.remove('top-[-100px]', 'opacity-0');
            toast.classList.add('top-6', 'opacity-100');
            
            // Auto hide
            setTimeout(() => {
                toast.classList.remove('top-6', 'opacity-100');
                toast.classList.add('top-[-100px]', 'opacity-0');
            }, 3500);
        };

        // UI Transition Helper
        function showStage(stageId) {
            // HARD GATE: Prevent seeing any stage except login if profile is missing
            const localProfile = localStorage.getItem('parentProfile');
            
            // Allow loginStage always, but force it if no profile exists
            if (stageId !== 'loginStage' && !localProfile && !currentUser) {
                stageId = 'loginStage';
            }

            // Hide all
            document.querySelectorAll('.stage').forEach(s => {
                s.classList.add('hidden');
                s.style.display = 'none'; // Extra safety
            });

            // Show target
            const stage = document.getElementById(stageId);
            if (stage) {
                stage.classList.remove('hidden');
                stage.style.display = 'block';
            }
            
            window.scrollTo(0,0);
            
            const logoutBtn = document.getElementById('logoutBtn');
            if (logoutBtn) {
                if (stageId !== 'loginStage') logoutBtn.classList.remove('hidden');
                else logoutBtn.classList.add('hidden');
            }
        }

        // --- AUTH LOGIC ---
        onAuthStateChanged(auth, async (user) => {

            if (user) {
                currentUser = user;
                const dName = user.displayName || localStorage.getItem('parentName') || "Parent";
                const userInit = document.getElementById('userInitial');
                const userLabel = document.getElementById('userNameLabel');
                if (userLabel) userLabel.textContent = dName;
                if (userInit) userInit.textContent = dName.charAt(0).toUpperCase();
                
                showStage('dashboardStage');
                loadStudents();
                checkQuickResume();
            } else {
                const loggedInPhone = localStorage.getItem('loggedInParent');
                const localProfile = localStorage.getItem('parentProfile');
                
                if (loggedInPhone || localProfile) {
                    try {
                        const name = localProfile ? JSON.parse(localProfile).name : (loggedInPhone + "'s Parent");
                        currentUser = { displayName: name, email: `${loggedInPhone || 'user'}@atteni.parent`, uid: `parent_${loggedInPhone || 'user'}` };
                        
                        const userInit = document.getElementById('userInitial');
                        const userLabel = document.getElementById('userNameLabel');
                        if (userLabel) userLabel.textContent = name;
                        if (userInit) userInit.textContent = name.charAt(0).toUpperCase();
                        
                        showStage('dashboardStage');
                        loadStudents();
                        checkQuickResume();
                    } catch(e) {
                        localStorage.removeItem('parentProfile');
                        showStage('loginStage');
                    }
                } else {
                    showStage('loginStage');
                }
            }
        });

        // Listen for global force update
        onValue(ref(db, `${dbPath}/system/forceUpdate`), snap => {
            const overlay = document.getElementById('forceUpdateOverlay');
            if (overlay) {
                const isDismissed = sessionStorage.getItem('atteniUpdateDismissed') === 'true';
                if (snap.val() === true && !isDismissed) {
                    overlay.classList.remove('hidden');
                } else {
                    overlay.classList.add('hidden');
                }
            }
        });

        window.dismissUpdatePrompt = () => {
            sessionStorage.setItem('atteniUpdateDismissed', 'true');
            const overlay = document.getElementById('forceUpdateOverlay');
            if (overlay) overlay.classList.add('hidden');
        };

        window.openPlayStore = () => {
            const pkg = 'com.piyush.atteni';
            const webUrl = `https://play.google.com/store/apps/details?id=${pkg}`;
            // intent:// scheme works correctly inside Android WebView
            // market:// gets intercepted and treated as a browser search — do NOT use it in WebView
            const intentUrl = `intent://details?id=${pkg}#Intent;scheme=market;package=com.android.vending;S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;
            const isWebView = /wv|WebView/.test(navigator.userAgent) ||
                             (typeof Android !== 'undefined');
            if (isWebView) {
                window.location.href = intentUrl;
            } else {
                window.open(webUrl, '_blank');
            }
        };

        // Fix #2: checkQuickResume — show a tappable toast to resume last viewed student
        function checkQuickResume() {
            const last = localStorage.getItem('atteni_last_student');
            if (!last) return;
            try {
                const s = JSON.parse(last);
                if (s && s.id && s.name) {
                    setTimeout(() => {
                        const toast = document.getElementById('toast');
                        if (!toast) return;
                        toast.innerHTML = `<i class="fa-solid fa-rotate-right mr-2"></i>Resume: <b>${s.name}</b>`;
                        toast.classList.remove('hidden');
                        toast.style.cursor = 'pointer';
                        toast.onclick = () => {
                            toast.classList.add('hidden');
                            toast.onclick = null;
                            viewStudent(s.id);
                        };
                        setTimeout(() => {
                            toast.classList.add('hidden');
                            toast.onclick = null;
                        }, 6000);
                    }, 1200);
                }
            } catch(e) {
                localStorage.removeItem('atteni_last_student');
            }
        }



        window.handleNativeLoginResult = (email, name, photo) => {
            const uid = 'native_' + btoa(email).replace(/=/g, "");
            currentUser = { uid: uid, email: email, displayName: name };
            document.getElementById('userNameLabel').textContent = name;
            document.getElementById('userInitial').textContent = name.charAt(0).toUpperCase();
            
            showStage('dashboardStage');
            loadStudents();
        };

        // --- SMART REDIRECTION & DEEP LINKING ---
        function checkDeviceAndRedirect() {
            const userAgent = navigator.userAgent || navigator.vendor || window.opera;
            const isAndroid = /android/i.test(userAgent);
            const isIOS = /iPad|iPhone|iPod/.test(userAgent) && !window.MSStream;
            
            // Check if already inside the app WebView
            const isWebView = userAgent.includes('wv') || userAgent.includes('WebView') || (isIOS && !userAgent.includes('Safari'));
            if (isWebView) return; 

            // Pre-fill school from URL
            const params = new URLSearchParams(window.location.search);
            const schoolParam = params.get('school');
            if (schoolParam) {
                const el = document.getElementById('parentSchool');
                if (el) el.value = schoolParam.replace(/_/g, ' ');
            }

            if (isAndroid) {
                // Smart Intent: Try to open app, fallback to Play Store automatically
                // No "Continue" popup - the system handles the transition
                const playStoreUrl = `https://play.google.com/store/apps/details?id=com.piyush.atteni&referrer=${encodeURIComponent(schoolParam || 'none')}`;
                const intentUrl = `intent://parent?school=${schoolParam || ''}#Intent;scheme=atteni;package=com.piyush.atteni;S.browser_fallback_url=${encodeURIComponent(playStoreUrl)};end`;
                
                // Show a small "Redirecting..." overlay so the user knows what's happening
                const overlay = document.createElement('div');
                overlay.className = "fixed inset-0 bg-slate-900 z-[9999] flex flex-col items-center justify-center text-white p-8 text-center";
                overlay.innerHTML = `
                    <div class="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-6"></div>
                    <h2 class="text-xl font-bold mb-2">Launching Atteni App</h2>
                    <p class="text-slate-400 text-sm">Opening live tracking... If you don't have the app, we'll take you to the Play Store.</p>
                `;
                document.body.appendChild(overlay);

                // Perform redirect after a tiny delay to ensure browser doesn't block it as "non-user-triggered"
                setTimeout(() => {
                    window.location.href = intentUrl;
                }, 500);
            }
            // iOS users remain in browser as requested.
        }
        window.addEventListener('load', checkDeviceAndRedirect);

        window.redirectToPlayStore = () => {
            const url = "https://play.google.com/store/apps/details?id=com.piyush.atteni&showAllReviews=true";
            window.open(url, '_blank');
            document.getElementById('rateUsModal').classList.add('hidden');
            localStorage.setItem('atteni_usage_views', '100'); // Don't ask again soon
        };

        // --- TEST STUDENT SEED DATA ---
        const seedStudentId = 'seed_piyush_assudani';
        get(ref(db, `${dbPath}/students/${seedStudentId}`)).then(snap => {
            if (!snap.exists()) {
                set(ref(db, `${dbPath}/students/${seedStudentId}`), {
                    id: seedStudentId,
                    name: 'piyush assudani',
                    class: 'XII',
                    section: 'A',
                    parentPhones: ['9413879444'],
                    addedAt: new Date().toISOString(),
                    vehicle: 'None'
                });
            }
        });

        // --- END OTP & AUTH LOGIC ---

        // ==========================================
        // CUSTOM BACKEND API CONFIGURATION
        // ==========================================
        const CUSTOM_BACKEND_URL = "http://localhost:3000";

        async function requestOTP(phone) {
            return await fetch(`${CUSTOM_BACKEND_URL}/api/request-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone })
            });
        }

        async function verifyOTP(phone, code) {
            const res = await fetch(`${CUSTOM_BACKEND_URL}/api/verify-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone, code })
            });
            return res.json();
        }

        function setupOtpBoxes() {
            const inputs = document.querySelectorAll('.otp-box');
            inputs.forEach((input, index) => {
                input.addEventListener('input', (e) => {
                    e.target.value = e.target.value.replace(/[^0-9]/g, '');
                    if (e.target.value.length > 1) e.target.value = e.target.value.slice(0, 1);
                    if (e.target.value && index < inputs.length - 1) inputs[index + 1].focus();
                });
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Backspace' && !e.target.value && index > 0) inputs[index - 1].focus();
                });
            });
        }
        setupOtpBoxes();

        window.showLoginError = function(msg, showTryAgain = false) {
            const errSec = document.getElementById('loginErrorSection');
            const errMsg = document.getElementById('loginErrorMsg');
            const btnTryAgain = document.getElementById('btnTryAgain');
            
            errSec.classList.remove('hidden');
            errMsg.textContent = msg;
            
            if (showTryAgain) {
                btnTryAgain.classList.remove('hidden');
            } else {
                btnTryAgain.classList.add('hidden');
            }
        };

        // --- PARENT AUTH UTILS & HELPERS ---
        window.switchLoginTab = (tab) => {
            const loginBtn = document.getElementById('tab-login-btn');
            const signupBtn = document.getElementById('tab-signup-btn');
            const loginView = document.getElementById('loginView');
            const signupView = document.getElementById('signupView');

            if (tab === 'login') {
                loginBtn.className = "flex-1 py-3 text-sm font-bold rounded-xl transition-all bg-white text-indigo-600 shadow-sm";
                signupBtn.className = "flex-1 py-3 text-sm font-bold rounded-xl transition-all text-slate-500 hover:text-slate-800";
                loginView.classList.remove('hidden');
                signupView.classList.add('hidden');
            } else {
                signupBtn.className = "flex-1 py-3 text-sm font-bold rounded-xl transition-all bg-white text-indigo-600 shadow-sm";
                loginBtn.className = "flex-1 py-3 text-sm font-bold rounded-xl transition-all text-slate-500 hover:text-slate-800";
                signupView.classList.remove('hidden');
                loginView.classList.add('hidden');
            }
        };

        let signupMobileNum = '';
        let matchedStudentsForSignup = [];

        window.checkSignupMobile = async () => {
            const rawMobile = document.getElementById('signupMobile').value.trim();
            const cleanMobile = rawMobile.replace(/\D/g, '').slice(-10);

            if (cleanMobile.length !== 10) {
                showToast("Please enter a valid 10-digit mobile number.", 'error');
                return;
            }

            signupMobileNum = cleanMobile;

            try {
                const response = await requestOTP(signupMobileNum);
                
                if (response.ok) {
                    document.getElementById('signup-step1').classList.add('hidden');
                    document.getElementById('signup-step2').classList.remove('hidden');
                    document.getElementById('signupOtp').value = '';
                } else {
                    const data = await response.json().catch(() => ({}));
                    showToast(data.message || "Failed to send OTP", 'error');
                }
            } catch (err) {
                showToast("Cannot send OTP. Try again later.", 'error');
            }
        };

        // Called after OTP verified — fetches DB and shows matched children
        async function fetchAndShowMatchedChildren() {
            try {
                const snap = await get(child(ref(db), `${dbPath}/students`));
                matchedStudentsForSignup = [];
                if (snap.exists()) {
                    Object.entries(snap.val()).forEach(([id, s]) => {
                        let phones = s.parentPhones || [];
                        if (!Array.isArray(phones)) phones = [phones];
                        const matches = phones.some(p => String(p).replace(/\D/g, '').slice(-10) === signupMobileNum);
                        if (matches) {
                            matchedStudentsForSignup.push({ id, ...s });
                        }
                    });
                }

                if (matchedStudentsForSignup.length === 0) {
                    showToast("Your number is verified, but is not linked to any student record yet.", 'error');
                    document.getElementById('signup-step2').classList.add('hidden');
                    document.getElementById('signup-step1').classList.remove('hidden');
                    return;
                }

                const container = document.getElementById('signupChildrenContainer');
                container.innerHTML = matchedStudentsForSignup.map(s => `
                    <div class="glass-card p-4 rounded-xl border border-indigo-100 flex items-center gap-3 bg-white/50">
                        <div class="w-10 h-10 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold">${s.name.charAt(0)}</div>
                        <div>
                            <h4 class="font-bold text-slate-800 text-sm">${s.name}</h4>
                            <p class="text-[9px] text-slate-400 font-bold uppercase tracking-wider">Class ${normalizeClassLabel(s.class)} &bull; Section ${s.section || 'A'}</p>
                        </div>
                    </div>
                `).join('');

                // OTP done → show step 3 (confirm children)
                document.getElementById('signup-step2').classList.add('hidden');
                document.getElementById('signup-step3').classList.remove('hidden');

            } catch (err) {
                showToast("Failed to fetch student records: " + err.message, 'error');
            }
        }

        window.verifySignupOtp = async () => {
            const otpCode = document.getElementById('signupOtp').value.trim();
            if (!otpCode) {
                showToast("Please enter the verification code.", 'error');
                return;
            }

            try {
                const data = await verifyOTP(signupMobileNum, otpCode);

                if (data.success && data.token) {
                    await signInWithCustomToken(auth, data.token);
                    // OTP verified! Now fetch matched children
                    await fetchAndShowMatchedChildren();
                } else {
                    showToast(data.message || "Invalid OTP. Please check and try again.", 'error');
                }
            } catch (err) {
                console.error("OTP verification error:", err);
                showToast("Invalid OTP. Please check and try again.", 'error');
            }
        };

        window.confirmChildren = (isCorrect) => {
            if (!isCorrect) {
                showToast("Please contact the school admin to correct your registered mobile number.", 'error');
                document.getElementById('signup-step3').classList.add('hidden');
                document.getElementById('signup-step1').classList.remove('hidden');
                return;
            }
            // Confirmed — go to password step
            document.getElementById('signup-step3').classList.add('hidden');
            document.getElementById('signup-step4').classList.remove('hidden');
        };

        window.saveSignupPassword = async () => {
            const password = document.getElementById('signupPassword').value.trim();
            if (!password || password.length < 4) {
                showToast("Please enter a password with at least 4 characters.", 'error');
                return;
            }

            try {
                const profile = {
                    mobile: signupMobileNum,
                    password: password,
                    name: matchedStudentsForSignup[0].name.split(' ')[0] + "'s Parent",
                    email: signupMobileNum + '@atteni.parent',
                    uid: 'parent_' + signupMobileNum,
                    joined: Date.now()
                };

                await set(ref(db, `${dbPath}/parent_accounts/${signupMobileNum}`), profile);

                for (const student of matchedStudentsForSignup) {
                    await set(ref(db, `artifacts/${appId}/users/${profile.uid}/tracked_students/${student.id}`), student);
                }

                document.getElementById('oneTimePasswordModal').classList.remove('hidden');

            } catch (err) {
                showToast("Failed to save password: " + err.message, 'error');
            }
        };

        window.closePasswordModalAndLogin = () => {
            document.getElementById('oneTimePasswordModal').classList.add('hidden');
            
            const parentProfile = {
                name: matchedStudentsForSignup[0].name.split(' ')[0] + "'s Parent",
                email: signupMobileNum + '@atteni.parent',
                uid: 'parent_' + signupMobileNum,
                joined: Date.now()
            };
            localStorage.setItem('parentProfile', JSON.stringify(parentProfile));
            localStorage.setItem('parentName', parentProfile.name);
            
            location.reload();
        };

        document.getElementById('parentLoginForm').onsubmit = async (e) => {
            e.preventDefault();
            const mobile = document.getElementById('loginMobile').value.trim().replace(/\D/g, '').slice(-10);
            const pwd = document.getElementById('loginPassword').value.trim();

            if (mobile.length !== 10) {
                showToast("Please enter a valid 10-digit mobile number.", 'error');
                return;
            }
            if (!pwd) {
                showToast("Please enter your password.", 'error');
                return;
            }

            const btn = document.getElementById('btnVerifyLogin');
            const origText = btn.innerHTML;
            btn.innerHTML = 'Logging in...';
            btn.disabled = true;

            try {
                const snap = await get(child(ref(db), `${dbPath}/parent_accounts/${mobile}`));
                if (snap.exists()) {
                    const parentData = snap.val();
                    if (parentData.password === pwd) {
                        localStorage.setItem('loggedInParent', mobile);
                        localStorage.setItem('parentProfile', JSON.stringify(parentData));
                        localStorage.setItem('parentName', parentData.name || 'Parent');
                        location.reload();
                    } else {
                        showToast("Incorrect password. Please try again.", 'error');
                    }
                } else {
                    showToast("Account not found. Please sign up first.", 'error');
                }
            } catch (err) {
                showToast("Login failed: " + err.message, 'error');
            } finally {
                btn.innerHTML = origText;
                btn.disabled = false;
            }
        };

        document.getElementById('parentLoginForm').onsubmit = async (e) => {
            e.preventDefault();
            const mobile = document.getElementById('loginMobile').value.trim().replace(/\D/g, '').slice(-10);
            const otpInputs = Array.from(document.querySelectorAll('.otp-box'));
            const otp = otpInputs.map(i => i.value).join('');

            if (otp.length !== 4) {
                showLoginError("Please enter the 4-digit OTP.", false);
                return;
            }

            const btn = document.getElementById('btnVerifyLoginOtp');
            const origText = btn.innerHTML;
            btn.innerHTML = 'Verifying...';
            btn.disabled = true;

            try {
                // Call actual verify API
                const data = await verifyOTP(mobile, otp);

                if (data.success && data.token) {
                    await signInWithCustomToken(auth, data.token);
                    localStorage.setItem('loggedInParent', mobile);
                    location.reload();
                } else {
                    showLoginError(data.message || "Invalid OTP. Please try again.", true);
                }
            } catch (err) {
                showToast("Cannot verify OTP. Try again later.");
                resetLoginState();
            } finally {
                btn.innerHTML = origText;
                btn.disabled = false;
            }
        };

        document.getElementById('logoutBtn').onclick = async () => {
            await signOut(auth);
            localStorage.removeItem('parentProfile');
            localStorage.removeItem('parentName');
            localStorage.removeItem('atteni_last_student');
            location.reload();
        };

        // --- STUDENT & TRACKING LOGIC ---
        let trackedStudents = [];

        async function loadStudents() {
            const CACHE_KEY = 'atteni_cache_all_students';
            const cached = localStorage.getItem(CACHE_KEY);
            if (cached) {
                try {
                    students = JSON.parse(cached);
                    loadTrackedStudents(); // Render immediately with stale data
                } catch(e) {}
            }
            
            // Fetch fresh in background (Stale-While-Revalidate)
            get(child(ref(db), `${dbPath}/students`)).then(snap => {
                if (snap.exists()) {
                    students = Object.entries(snap.val()).map(([id, val]) => ({ id, ...val }));
                    localStorage.setItem(CACHE_KEY, JSON.stringify(students));
                    loadTrackedStudents(); // Always re-render so live data overrides cache
                }
            }).catch(e => console.warn('Background students fetch failed', e));
        }

        async function loadTrackedStudents() {
            const container = document.getElementById('trackedStudentsList');
            const skeleton = document.getElementById('skeletonList');
            const countEl = document.getElementById('childCount');
            const emptyMsg = document.getElementById('emptyTrackedMsg');

            // Show skeleton while loading
            if (skeleton) skeleton.classList.remove('hidden');
            container.classList.add('hidden');

            // Fix: Firebase is the single source of truth.
            // LocalStorage is only used as a fast write-cache when Firebase is unavailable.
            // Strategy: Firebase first → if not logged in, fall back to localStorage.
            // After merge, always write deduped canonical list back to localStorage.
            trackedStudents = [];

            // 1. Primary source: Firebase (if logged in)
            if (currentUser) {
                try {
                    const path = `artifacts/${appId}/users/${currentUser.uid}/tracked_students`;
                    const snap = await get(child(ref(db), path));
                    if (snap.exists()) {
                        trackedStudents = Object.values(snap.val()).filter(Boolean);
                    }
                } catch (e) {
                    console.warn('Firebase tracked_students fetch failed, falling back to localStorage', e);
                }
            }

            // 2. Merge localStorage only if Firebase returned nothing (offline / not logged in)
            if (trackedStudents.length === 0) {
                const local = localStorage.getItem('atteni_tracked_students');
                if (local) {
                    try { trackedStudents = JSON.parse(local).filter(Boolean); } catch (e) {}
                }
            }

            // 3. Deduplicate by student id (last-wins for same id)
            const seen = new Map();
            trackedStudents.forEach(s => { if (s && s.id) seen.set(s.id, s); });
            trackedStudents = Array.from(seen.values());

            // 4. Write canonical deduped list back to localStorage as cache
            localStorage.setItem('atteni_tracked_students', JSON.stringify(trackedStudents));

            // 5. Hide skeleton, show real list
            if (skeleton) skeleton.classList.add('hidden');
            container.classList.remove('hidden');

            // 6. Render
            if (trackedStudents.length === 0) {
                emptyMsg.classList.remove('hidden');
                container.innerHTML = '';
                container.appendChild(emptyMsg);
                countEl.textContent = '0';
                return;
            }

            emptyMsg.classList.add('hidden');
            countEl.textContent = trackedStudents.length;
            container.innerHTML = trackedStudents.map(s => `
                <div class="glass-card p-5 rounded-2xl flex justify-between items-center transition-all hover:bg-white/80 group">
                    <div class="flex items-center gap-4 cursor-pointer flex-1" onclick="viewStudent('${s.id}')">
                        <div class="w-12 h-12 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold text-lg shadow-lg group-hover:scale-105 transition-transform">${s.name.charAt(0)}</div>
                        <div>
                            <h4 class="font-bold text-slate-800">${s.name}</h4>
                            <p class="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Class ${normalizeClassLabel(s.class)} • Section ${s.section || 'A'}</p>
                        </div>
                    </div>
                    <button onclick="toggleTrackStudent('${s.id}')" class="w-8 h-8 rounded-lg bg-slate-50 text-slate-300 hover:text-rose-500 hover:bg-rose-50 transition-all">
                        <i class="fa-solid fa-trash-can text-sm"></i>
                    </button>
                </div>
            `).join('');
        }

        window.performSmartSearch = async () => {
            const sNameRaw = document.getElementById('studentSearchName').value.trim().toLowerCase();
            const sClassRaw = document.getElementById('studentSearchClass').value.trim().toUpperCase();
            const sSection = document.getElementById('studentSearchSection').value.trim().toLowerCase() || 'a';
            const statusEl = document.getElementById('searchStatus');
            const resultsStage = document.getElementById('searchResults');
            const resultsContainer = document.getElementById('searchResultsContainer');

            if (!sNameRaw || !sClassRaw) {
                alert("Please enter Name and Class to search.");
                return;
            }

            statusEl.classList.remove('hidden');
            resultsStage.classList.add('hidden');

            const sClass = normalizeClassLabel(sClassRaw);
            let matches = [];

            students.forEach(d => {
                const dbClass = normalizeClassLabel(d.class);
                const dbSection = String(d.section || 'a').toLowerCase();

                // Strict Class and Section Match (Privacy)
                if (dbClass === sClass && dbSection === sSection) {
                    const dbName = String(d.name || '').trim().toLowerCase();
                    const dbFirstName = dbName.split(' ')[0];
                    const sFirstName = sNameRaw.split(' ')[0];

                    if (dbName === sNameRaw) {
                        matches.push({ weight: 100, ...d });
                    } else if (dbFirstName === sFirstName) {
                        if (sNameRaw.length >= sFirstName.length && dbName.startsWith(sNameRaw)) {
                            matches.push({ weight: 80, ...d });
                        } else {
                            matches.push({ weight: 50, ...d });
                        }
                    } else if (dbName.includes(sNameRaw)) {
                        matches.push({ weight: 30, ...d });
                    }
                }
            });

            statusEl.classList.add('hidden');
            resultsStage.classList.remove('hidden');

            // Fix #5: Hide label when no results, show when results exist
            const matchLabel = document.getElementById('searchMatchLabel');
            if (matches.length === 0) {
                if (matchLabel) matchLabel.classList.add('hidden');
                resultsContainer.innerHTML = `<div class="text-center py-6 text-slate-400 text-xs font-bold uppercase tracking-widest">No student found in Class ${sClass} - ${sSection.toUpperCase()}.</div>`;
                return;
            }
            if (matchLabel) matchLabel.classList.remove('hidden');

            matches.sort((a, b) => b.weight - a.weight);

            resultsContainer.innerHTML = matches.map(s => `
                <div class="glass-card p-5 rounded-2xl flex justify-between items-center border-indigo-200 bg-indigo-50/30">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 rounded-xl bg-white text-indigo-600 flex items-center justify-center font-bold text-lg shadow-sm border border-indigo-100">${s.name.charAt(0)}</div>
                        <div>
                            <h4 class="font-bold text-slate-800">${s.name}</h4>
                            <p class="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Class ${normalizeClassLabel(s.class)} • Section ${s.section || 'A'}</p>
                        </div>
                    </div>
                    <button id="trackBtn_${s.id}" onclick="toggleTrackStudent('${s.id}', true)" class="btn-premium text-white px-4 py-2 rounded-xl text-[10px] font-bold shadow-md shadow-indigo-500/20">
                        TRACK CHILD
                    </button>
                </div>
            `).join('');
        }

        window.toggleTrackStudent = async (sid, forceAdd = false) => {
            const student = students.find(s => s.id === sid);
            if (!student) return;

            const idx = trackedStudents.findIndex(t => t.id === sid);
            const btn = document.getElementById(`trackBtn_${sid}`);
            
            if (idx > -1 && !forceAdd) {
                if (!confirm("Remove this child from your tracking list?")) return;
                trackedStudents.splice(idx, 1);
            } else if (idx === -1) {
                trackedStudents.push(student);
                if (btn) {
                    btn.innerHTML = '<i class="fa-solid fa-check mr-1"></i> ADDED';
                    btn.classList.replace('btn-premium', 'bg-emerald-500');
                    btn.disabled = true;
                }
            } else if (forceAdd && idx > -1) {
                // Already added - just view
                viewStudent(sid);
                return;
            }

            // Sync
            localStorage.setItem('atteni_tracked_students', JSON.stringify(trackedStudents));
            if (currentUser) {
                const path = `artifacts/${appId}/users/${currentUser.uid}/tracked_students/${sid}`;
                if (idx > -1 && !forceAdd) await set(ref(db, path), null);
                else await set(ref(db, path), student);
            }

            // Short delay to show "Added" then refresh/view
            setTimeout(() => {
                document.getElementById('searchResults').classList.add('hidden');
                loadTrackedStudents();
                if (forceAdd) viewStudent(sid);
            }, forceAdd ? 800 : 0);
        }

        window.viewStudent = async (id) => {
            const s = students.find(x => x.id === id);
            if (!s) return;
            selectedStudent = s;
            localStorage.setItem('atteni_last_student', JSON.stringify(s));

            const card = document.getElementById('studentMainCard');
            card.innerHTML = `
                <div class="w-20 h-20 bg-indigo-600 text-white rounded-[2rem] flex items-center justify-center text-3xl font-extrabold mx-auto mb-4 shadow-xl shadow-indigo-200">${s.name.charAt(0)}</div>
                <h3 class="text-2xl font-black text-slate-800">${s.name}</h3>
                <p class="text-slate-500 font-medium mb-4">Class ${normalizeClassLabel(s.class)} &nbsp;•&nbsp; Section ${s.section || 'A'}</p>
                <div class="flex items-center justify-between text-left p-4 bg-slate-50/50 rounded-2xl border border-white/50">
                    <div>
                        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest block">Vehicle</span>
                        <span class="font-bold text-slate-700">${s.vehicle || 'Not assigned'}</span>
                    </div>
                    <div class="text-right">
                        <span id="detailStatus" class="badge bg-slate-100 text-slate-400 px-3 py-1 rounded-full text-[10px] font-extrabold">SYNCING</span>
                    </div>
                </div>
                <div id="syncBanner" class="mt-3 p-2 bg-amber-50 border border-amber-200 text-amber-700 text-xs rounded-lg font-medium flex items-center justify-center gap-2 transition-all">
                    <i class="bi bi-arrow-repeat animate-spin text-sm"></i>
                    <span>Fetching live status...</span>
                </div>
            `;
            
            showStage('studentDetailStage');
            initDashboard(s);
            
            // Usage tracking for review prompt
            let views = parseInt(localStorage.getItem('atteni_usage_views') || '0');
            views++;
            localStorage.setItem('atteni_usage_views', views);
            if (views === 5 || views === 15) {
                setTimeout(() => {
                    document.getElementById('rateUsModal').classList.remove('hidden');
                }, 3000);
            }
        };

        async function initDashboard(student) {
            // Reset UI
            document.getElementById('statPresent').textContent = '-';
            document.getElementById('statAbsent').textContent = '-';
            document.getElementById('statRate').textContent = '-%';
            document.getElementById('journeyTrackerContainer').classList.add('hidden');
            
            // Sync journey duration UI
            const savedDuration = localStorage.getItem(`journey_time_${student.id}`) || '45';
            document.getElementById('journeyDurationInput').value = savedDuration;
            document.getElementById('durationDisplay').textContent = `${savedDuration} Mins`;

            // Auto-load history
            loadMonthlyHistory(student.id);
            
            // Listen for Today's Attendance
            const setupAttendanceListener = () => {
                const today = getServerDate();
                const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
                
                // Clear any existing listeners if needed (not strictly required for one student, but safe)
                const attRef = ref(db, `${dbPath}/attendance/${dateStr}/list/${student.id}`);
                
                onValue(attRef, (snap) => {
                    const entry = snap.val();
                    const badge = document.getElementById('detailStatus');
                    if (snap.exists()) {
                        const status = (entry && typeof entry === 'object') ? entry.status : entry;
                        const isP = ['P', 'Present', true].includes(status) || (typeof status === 'string' && status.toLowerCase().startsWith('p'));
                        badge.textContent = isP ? 'PRESENT' : 'ABSENT';
                        badge.className = `badge ${isP ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-600'} px-3 py-1 rounded-full text-[10px] font-extrabold`;
                        
                        // Show Tracker if Present
                        if (isP) {
                            document.getElementById('journeyTrackerContainer').classList.remove('hidden');
                            const markTime = (entry && typeof entry === 'object') ? entry.markedAt : null;
                            startJourneyTracker(student.id, markTime);
                        } else {
                            document.getElementById('journeyTrackerContainer').classList.add('hidden');
                            clearInterval(journeyTimerInterval);
                        }
                    } else {
                        badge.textContent = 'PENDING';
                        badge.className = 'badge bg-slate-100 text-slate-400 px-3 py-1 rounded-full text-[10px] font-extrabold';
                        document.getElementById('journeyTrackerContainer').classList.add('hidden');
                        clearInterval(journeyTimerInterval);
                    }
                });

                // Midnight Reset Logic
                const nextMidnight = new Date(today);
                nextMidnight.setHours(24, 0, 0, 0);
                const msUntilMidnight = nextMidnight.getTime() - today.getTime();
                setTimeout(() => {
                    console.log("Midnight reached. Resetting dashboard state...");
                    setupAttendanceListener(); // Re-bind for new date
                }, msUntilMidnight + 1000); 
            };

            setupAttendanceListener();
        }

        window.updateJourneyDuration = (val) => {
            if (!selectedStudent) return;
            localStorage.setItem(`journey_time_${selectedStudent.id}`, val);
            document.getElementById('durationDisplay').textContent = `${val} Mins`;
            
            // Fix: Pass cachedJourneyStartTime directly — no new Firebase read, no clock skew.
            // cachedJourneyStartTime is already set when the tracker first started.
            if (cachedJourneyStartTime) {
                startJourneyTracker(selectedStudent.id, null); // startTime already cached
            }
        };

        function startJourneyTracker(studentId, markedAt) {
            clearInterval(journeyTimerInterval);
            const totalDurationMins = parseInt(localStorage.getItem(`journey_time_${studentId}`) || '45');
            const totalSeconds = totalDurationMins * 60;

            // Fix: Only recalculate startTime if a new markedAt is passed (first call from Firebase).
            // Slider changes call with markedAt=null — reuse cachedJourneyStartTime to avoid clock skew.
            if (markedAt) {
                cachedJourneyStartTime = new Date(markedAt).getTime();
            } else if (!cachedJourneyStartTime) {
                // Final fallback: assume departure at 8:00 AM today
                const fallback = new Date(getServerDate());
                fallback.setHours(8, 0, 0, 0);
                cachedJourneyStartTime = fallback.getTime();
            }
            const startTime = cachedJourneyStartTime;

            const update = () => {
                const now = getServerDate().getTime();
                const elapsed = Math.floor((now - startTime) / 1000);

                if (elapsed < 0) { // Safety for clock skew
                    document.getElementById('trackerStatusText').textContent = 'Waiting for departure...';
                    document.getElementById('trackerProgress').style.width = '0%';
                    document.getElementById('movingDot').style.left = '2%';
                    return;
                }

                const rawProgress = Math.min((elapsed / totalSeconds) * 100, 100);

                // Fix: Clamp dot position to [2%, 98%] so it never overflows container edges
                const dotPosition = Math.max(2, Math.min(98, rawProgress));

                document.getElementById('trackerProgress').style.width = `${rawProgress}%`;
                document.getElementById('movingDot').style.left = `${dotPosition}%`;

                const badge = document.getElementById('timeLeftBadge');
                badge.style.opacity = '1';

                if (rawProgress >= 100) {
                    badge.textContent = 'HOME';
                    document.getElementById('trackerStatusText').textContent = 'Reached Home';
                    document.getElementById('estimatedArrivalText').textContent = 'Vehicle arrived at destination';
                    clearInterval(journeyTimerInterval);
                } else {
                    const remaining = Math.max(0, Math.floor((totalSeconds - elapsed) / 60));
                    badge.textContent = `${remaining} min`;
                    document.getElementById('trackerStatusText').textContent = 'Vehicle En-Route';
                    document.getElementById('estimatedArrivalText').textContent = `ETA: ~${remaining} mins to destination`;
                }
            };
            update();
            journeyTimerInterval = setInterval(update, 1000);
        }

        // Fix #1: Build all 30 date keys first, then fetch ALL in parallel with Promise.all
        // This replaces 30 sequential awaits with a single concurrent batch — ~30x faster on slow networks
        async function loadMonthlyHistory(sid, forceRefresh = false) {
            historyStudentId = null; // Fix #7: mark as loading
            
            const todayKey = getServerDate().toISOString().split('T')[0];
            const HIST_CACHE_KEY = `atteni_hist_${sid}_${todayKey}`;
            let lastSyncedText = '';
            
            if (!forceRefresh) {
                const cached = localStorage.getItem(HIST_CACHE_KEY);
                if (cached) {
                    try {
                        const data = JSON.parse(cached);
                        if (data.timestamp) {
                            const diffMins = Math.floor((Date.now() - data.timestamp) / 60000);
                            lastSyncedText = diffMins > 60 ? `${Math.floor(diffMins/60)} hours ago` : `${diffMins} mins ago`;
                        }
                        
                        const banner = document.getElementById('syncBanner');
                        if (banner && lastSyncedText) {
                            banner.innerHTML = `<i class="bi bi-arrow-repeat animate-spin text-sm"></i><span>Last synced: ${lastSyncedText}. Fetching live status...</span>`;
                        }

                        currentHistoryForPDF = data.historyData;
                        historyStudentId = sid;
                        renderCharts(data.pCount, data.aCount, data.weeklyP, data.historyData);
                        renderCalendar(data.historyData);
                        // Removed 'return;' so it fetches fresh data in the background and updates!
                    } catch(e) {}
                }
            }

            const historyData = [];
            let pCount = 0, aCount = 0;
            const weeklyP = [0, 0, 0, 0];

            // Build date keys for last 30 days
            const dateKeys = [];
            for (let i = 0; i < 30; i++) {
                const d = getServerDate();
                d.setDate(d.getDate() - i);
                dateKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
            }

            // Fetch all 30 in parallel instead of sequential
            const snaps = await Promise.all(
                dateKeys.map(dateKey => get(child(ref(db), `${dbPath}/attendance/${dateKey}/list/${sid}`)))
            );

            for (let i = 0; i < 30; i++) {
                const snap = snaps[i];
                const status = (snap.exists() && typeof snap.val() === 'object') ? snap.val().status : snap.val();
                
                if (status) {
                    const isP = ['P', 'Present', true].includes(status) || (typeof status === 'string' && status.toLowerCase().startsWith('p'));
                    historyData.push({ date: dateKeys[i], isP });
                    if (isP) pCount++; else aCount++;
                    if (i < 28) weeklyP[Math.floor(i / 7)] += isP ? 1 : 0;
                }
            }

            currentHistoryForPDF = historyData;
            historyStudentId = sid; // Fix #7: mark load complete for this student
            
            // Cache the result for today
            const cachePayload = { timestamp: Date.now(), historyData, pCount, aCount, weeklyP };
            localStorage.setItem(HIST_CACHE_KEY, JSON.stringify(cachePayload));

            document.getElementById('statPresent').textContent = pCount;
            document.getElementById('statAbsent').textContent = aCount;
            const rate = (pCount + aCount) > 0 ? Math.round((pCount / (pCount + aCount)) * 100) : 0;
            document.getElementById('statRate').textContent = `${rate}%`;

            renderCharts(pCount, aCount, weeklyP, historyData);
            renderCalendar(historyData);
            
            // Re-render UI and indicate sync complete
            const banner = document.getElementById('syncBanner');
            if (banner) {
                banner.className = "mt-3 p-2 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded-lg font-medium flex items-center justify-center gap-2 transition-all";
                banner.innerHTML = `<i class="bi bi-check-circle-fill text-sm"></i><span>Live status updated</span>`;
                setTimeout(() => { 
                    banner.style.opacity = '0';
                    setTimeout(() => banner.classList.add('hidden'), 300);
                }, 3000);
            }
        }

        function renderCharts(p, a, weekly, history) {
            const commonOptions = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } };

            // Trend
            if (trendChartInstance) trendChartInstance.destroy();
            trendChartInstance = new Chart(document.getElementById('trendChart'), {
                type: 'line',
                data: {
                    labels: history.slice(0, 7).reverse().map(h => h.date.split('-')[2]),
                    datasets: [{ data: history.slice(0, 7).reverse().map(h => h.isP ? 1 : 0), borderColor: '#6366f1', tension: 0.4, fill: true, backgroundColor: 'rgba(99, 102, 241, 0.1)' }]
                },
                options: commonOptions
            });

            // Weekly
            if (barChartInstance) barChartInstance.destroy();
            barChartInstance = new Chart(document.getElementById('barChart'), {
                type: 'bar',
                data: { labels: ['W1', 'W2', 'W3', 'W4'], datasets: [{ data: weekly, backgroundColor: '#6366f1', borderRadius: 8 }] },
                options: commonOptions
            });

            // Pie
            if (pieChartInstance) pieChartInstance.destroy();
            pieChartInstance = new Chart(document.getElementById('pieChart'), {
                type: 'doughnut',
                data: { labels: ['Present', 'Absent'], datasets: [{ data: [p, a], backgroundColor: ['#10b981', '#ef4444'], borderWidth: 0 }] },
                options: { ...commonOptions, cutout: '70%', plugins: { legend: { display: true, position: 'bottom' } } }
            });
        }

        function renderCalendar(history) {
            const grid = document.getElementById('calendarGrid');
            const now = getServerDate();
            const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).getDay();
            
            grid.innerHTML = '';
            for (let i = 0; i < firstDay; i++) grid.innerHTML += '<div></div>';
            
            for (let d = 1; d <= daysInMonth; d++) {
                const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                const rec = history.find(h => h.date === dateKey);
                const color = rec ? (rec.isP ? 'bg-emerald-500' : 'bg-rose-500') : 'bg-slate-100';
                grid.innerHTML += `<div class="aspect-square rounded-lg ${color} flex items-center justify-center text-[10px] font-bold ${rec ? 'text-white' : 'text-slate-400'}">${d}</div>`;
            }
        }

        window.backToDashboard = () => showStage('dashboardStage');

        // --- PDF LOGIC ---
        window.downloadReport = async () => {
            if (!selectedStudent) return;
            // Fix #7: If history is stale (different student or not loaded), reload before generating PDF
            if (historyStudentId !== selectedStudent.id) {
                await loadMonthlyHistory(selectedStudent.id);
            }
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF();
            
            // Header with Mesh Branding
            doc.setFillColor(79, 70, 229);
            doc.rect(0, 0, 210, 45, 'F');
            doc.setTextColor(255, 255, 255);
            doc.setFontSize(26);
            doc.setFont("helvetica", "bold");
            doc.text("ATTENI PREMIUM", 105, 20, null, null, "center");
            doc.setFontSize(10);
            doc.setFont("helvetica", "normal");
            doc.text("Intelligent Attendance & Journey Tracking System", 105, 30, null, null, "center");
            
            // Student Profile
            doc.setTextColor(30, 41, 59);
            doc.setFontSize(16);
            doc.text(selectedStudent.name.toUpperCase(), 20, 60);
            doc.setFontSize(10);
            doc.setTextColor(100, 116, 139);
            doc.text(`Class: ${normalizeClassLabel(selectedStudent.class)} | Section: ${selectedStudent.section || 'A'}`, 20, 68);
            doc.text(`Vehicle: ${selectedStudent.vehicle || 'Not assigned'}`, 20, 74);
            
            // Summary Stats
            const pDays = document.getElementById('statPresent').textContent;
            const aDays = document.getElementById('statAbsent').textContent;
            const sRate = document.getElementById('statRate').textContent;

            doc.autoTable({
                startY: 85,
                head: [['Present Days', 'Absent Days', 'Success Rate']],
                body: [[pDays, aDays, sRate]],
                theme: 'plain',
                styles: { fontSize: 14, halign: 'center', textColor: [79, 70, 229], fontStyle: 'bold' },
                headStyles: { fontSize: 8, textColor: [148, 163, 184], fontStyle: 'normal' }
            });

            // 30-Day History Table
            doc.setTextColor(30, 41, 59);
            doc.setFontSize(12);
            doc.setFont("helvetica", "bold");
            doc.text("Last 30 Days Activity Log", 20, doc.lastAutoTable.finalY + 15);

            const tableData = currentHistoryForPDF.map(h => [
                h.date,
                h.isP ? 'PRESENT' : 'ABSENT',
                h.isP ? 'Verified on-board' : 'No mark recorded'
            ]);

            doc.autoTable({
                startY: doc.lastAutoTable.finalY + 20,
                head: [['Date', 'Status', 'Verification Note']],
                body: tableData,
                theme: 'striped',
                headStyles: { fillColor: [99, 102, 241], fontSize: 10 },
                bodyStyles: { fontSize: 9 },
                columnStyles: {
                    1: { fontStyle: 'bold' }
                },
                didParseCell: function(data) {
                    if (data.column.index === 1) {
                        if (data.cell.raw === 'PRESENT') data.cell.styles.textColor = [16, 185, 129];
                        else if (data.cell.raw === 'ABSENT') data.cell.styles.textColor = [239, 68, 68];
                    }
                }
            });

            doc.save(`${selectedStudent.name}_Monthly_Intelligence_Report.pdf`);
        };

        // --- ONBOARDING GUIDE ---
        window.startGuide = () => {
            const driver = window.driver.js.driver;
            const dObj = driver({
                showProgress: true,
                steps: [
                    { element: '#guideToggle', popover: { title: 'Help', description: 'Re-watch this guide anytime.' } },
                    { element: '#studentSearchName', popover: { title: 'Smart Search', description: 'Enter Name and Class to find your child.' } }
                ]
            });
            dObj.drive();
        };

        document.getElementById('loadHistoryBtn').onclick = () => {
            if (selectedStudent) {
                const btn = document.getElementById('loadHistoryBtn');
                const origText = btn.textContent;
                btn.textContent = 'REFRESHING...';
                loadMonthlyHistory(selectedStudent.id, true).finally(() => {
                    btn.textContent = origText;
                });
            }
        };

    // ═══════════════════════════════════════════════
    // LANGUAGE TOGGLE SYSTEM (Hindi / English)
    // ═══════════════════════════════════════════════
    window._lang = localStorage.getItem('atteni_lang') || 'en';

    const TRANSLATIONS = {
        en: {
            // Tabs
            'tab.login': 'Login', 'tab.signup': 'Sign Up',
            // Login
            'login.welcome': 'Welcome Back', 'login.subtitle': "Log in to view your child's tracking status.",
            'label.mobile': 'Mobile Number', 'label.password': 'Password',
            'ph.mobile': 'Enter 10-digit mobile number', 'ph.password': 'Enter your password',
            'btn.login': 'Login',
            // Signup
            'signup.title': 'Create Parent Account', 'signup.subtitle': "Register to track your child's real-time school transit.",
            'btn.continue': 'Continue',
            'signup.matched': 'Matched Children', 'signup.confirm': 'Are these your children?',
            'btn.yes': 'Yes, Continue', 'btn.no': 'No, Contact School',
            'signup.otpSent': 'An OTP has been sent to your registered mobile number.',
            'label.otp': 'Enter OTP', 'ph.otp': 'Enter OTP code', 'btn.verifyOtp': 'Verify OTP',
            'label.createPass': 'Create Password', 'ph.createPass': 'Create a secure password',
            'btn.setPass': 'Set Password & Login',
            // Dashboard
            'dash.profile': 'Parent Profile', 'dash.family': 'My Family',
            'dash.search.name': "Child's full name", 'dash.search.class': 'Class (e.g. 10)',
            'dash.search.section': 'Section (Optional)',
            'dash.search.btn': 'Find Student', 'dash.searching': 'Searching database...',
            'dash.matches': 'Exact Matches Found', 'dash.empty': 'No students tracked yet.\nUse the search above to find your child.',
            'dash.track': 'TRACK CHILD', 'dash.added': 'ADDED ✓',
            // Stats
            'stat.present': 'Present', 'stat.absent': 'Absent', 'stat.rate': 'Rate',
            // Student detail
            'detail.vehicle': 'Vehicle', 'detail.notAssigned': 'Not assigned',
            'detail.syncing': 'SYNCING', 'detail.fetchingLive': 'Fetching live status...',
            'detail.report': 'GENERATE SMART REPORT (PDF)',
            'detail.liveStatus': 'Live Status', 'detail.school': 'School', 'detail.home': 'Home',
            'detail.journeySettings': 'Journey Settings',
            'detail.noJourney': 'No active journey detected',
        },
        hi: {
            // Tabs
            'tab.login': 'लॉग इन', 'tab.signup': 'साइन अप',
            // Login
            'login.welcome': 'वापस आए! 🙏', 'login.subtitle': 'अपने बच्चे की उपस्थिति देखने के लिए लॉग इन करें।',
            'label.mobile': 'मोबाइल नंबर', 'label.password': 'पासवर्ड',
            'ph.mobile': '10 अंकों का मोबाइल नंबर डालें', 'ph.password': 'अपना पासवर्ड डालें',
            'btn.login': 'लॉग इन करें',
            // Signup
            'signup.title': 'अभिभावक खाता बनाएं', 'signup.subtitle': 'अपने बच्चे की स्कूल बस ट्रैकिंग के लिए रजिस्टर करें।',
            'btn.continue': 'जारी रखें',
            'signup.matched': 'मिले हुए बच्चे', 'signup.confirm': 'क्या ये आपके बच्चे हैं?',
            'btn.yes': 'हाँ, जारी रखें', 'btn.no': 'नहीं, स्कूल से संपर्क करें',
            'signup.otpSent': 'आपके मोबाइल नंबर पर OTP भेजा गया है।',
            'label.otp': 'OTP डालें', 'ph.otp': 'OTP कोड डालें', 'btn.verifyOtp': 'OTP सत्यापित करें',
            'label.createPass': 'पासवर्ड बनाएं', 'ph.createPass': 'एक मजबूत पासवर्ड बनाएं',
            'btn.setPass': 'पासवर्ड सेट करें और लॉग इन करें',
            // Dashboard
            'dash.profile': 'अभिभावक प्रोफाइल', 'dash.family': 'मेरा परिवार',
            'dash.search.name': 'बच्चे का पूरा नाम', 'dash.search.class': 'कक्षा (जैसे 10)',
            'dash.search.section': 'अनुभाग (वैकल्पिक)',
            'dash.search.btn': 'छात्र खोजें', 'dash.searching': 'खोज रहे हैं...',
            'dash.matches': 'मिले हुए परिणाम', 'dash.empty': 'अभी कोई बच्चा नहीं जुड़ा।\nऊपर खोजकर अपने बच्चे को जोड़ें।',
            'dash.track': 'ट्रैक करें', 'dash.added': 'जोड़ा गया ✓',
            // Stats
            'stat.present': 'उपस्थित', 'stat.absent': 'अनुपस्थित', 'stat.rate': 'दर',
            // Student detail
            'detail.vehicle': 'वाहन', 'detail.notAssigned': 'नियुक्त नहीं',
            'detail.syncing': 'सिंक हो रहा है', 'detail.fetchingLive': 'लाइव स्थिति देख रहे हैं...',
            'detail.report': 'स्मार्ट रिपोर्ट बनाएं (PDF)',
            'detail.liveStatus': 'लाइव स्थिति', 'detail.school': 'स्कूल', 'detail.home': 'घर',
            'detail.journeySettings': 'यात्रा सेटिंग',
            'detail.noJourney': 'कोई सक्रिय यात्रा नहीं मिली',
        }
    };

    function t(key) {
        return (TRANSLATIONS[window._lang] || TRANSLATIONS.en)[key] || (TRANSLATIONS.en[key] || key);
    }

    function applyLang() {
        const L = window._lang;
        // Text elements
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const val = t(key);
            if (val) el.textContent = val;
        });
        // Placeholder elements
        document.querySelectorAll('[data-i18n-ph]').forEach(el => {
            const key = el.getAttribute('data-i18n-ph');
            const val = t(key);
            if (val) el.placeholder = val;
        });
        // Search button special case (has icon)
        const searchBtn = document.getElementById('searchBtn');
        if (searchBtn) searchBtn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> ${t('dash.search.btn')}`;
        // Search placeholders
        const sName = document.getElementById('studentSearchName');
        if (sName) sName.placeholder = t('dash.search.name');
        const sClass = document.getElementById('studentSearchClass');
        if (sClass) sClass.placeholder = t('dash.search.class');
        const sSection = document.getElementById('studentSearchSection');
        if (sSection) sSection.placeholder = t('dash.search.section');
        // Search status & label
        const searchStatus = document.getElementById('searchStatus');
        if (searchStatus) searchStatus.textContent = t('dash.searching');
        const matchLabel = document.getElementById('searchMatchLabel');
        if (matchLabel) matchLabel.textContent = t('dash.matches');
        // Empty tracked msg
        const emptyMsg = document.getElementById('emptyTrackedMsg');
        if (emptyMsg) emptyMsg.innerHTML = t('dash.empty').replace('\n', '<br>');
        // Journey labels
        const tracker = document.getElementById('journeyTrackerContainer');
        if (tracker) {
            const liveLbl = tracker.querySelector('p');
            if (liveLbl) liveLbl.innerHTML = `<span class="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></span> ${t('detail.liveStatus')}`;
            const schoolLbl = tracker.querySelector('.flex-col:first-child span');
            if (schoolLbl) schoolLbl.textContent = t('detail.school');
            const homeLbl = tracker.querySelector('.flex-col:last-child span');
            if (homeLbl) homeLbl.textContent = t('detail.home');
        }
        // Lang button label
        const langBtnLabel = document.getElementById('langBtnLabel');
        const langBtnSub = document.getElementById('langBtnSub');
        if (langBtnLabel && langBtnSub) {
            if (L === 'hi') { langBtnLabel.textContent = 'A'; langBtnSub.textContent = 'EN'; }
            else { langBtnLabel.textContent = 'अ'; langBtnSub.textContent = 'HI'; }
        }
    }

    window.toggleLanguage = () => {
        window._lang = window._lang === 'en' ? 'hi' : 'en';
        localStorage.setItem('atteni_lang', window._lang);
        applyLang();
        // Re-render current dynamic content
        if (trackedStudents && trackedStudents.length > 0) loadTrackedStudents();
    };

    // Hide/show lang button based on which stage is active
    const _origShowStage = window.showStage || function(){};
    window._showStageWithLang = function(stageId) {
        const langBtn = document.getElementById('langToggleBtn');
        if (langBtn) {
            const parentStages = ['loginStage', 'dashboardStage', 'studentDetailStage'];
            langBtn.style.display = parentStages.includes(stageId) ? '' : 'none';
        }
    };
    // Patch showStage to also update lang button visibility
    const _origShowStageRef = showStage;
    showStage = function(stageId) {
        _origShowStageRef(stageId);
        window._showStageWithLang(stageId);
    };

    // Apply language on load
    applyLang();

    
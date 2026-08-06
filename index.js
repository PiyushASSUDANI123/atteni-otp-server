require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false
  },
  global: {
    fetch: fetch
  },
  websockets: WebSocket
});

// Initialize Firebase Admin
const serviceAccount = require('./buspro-4767d-firebase-adminsdk-fbsvc-6b3ea1d48e.json');
initializeApp({
  credential: cert(serviceAccount),
  databaseURL: process.env.FIREBASE_URL
});
const db = getDatabase();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ==========================================
// SUPABASE TASK MANAGER API ROUTES
// ==========================================

// Save or Update Daily Task
app.post('/api/tasks/save', async (req, res) => {
    try {
        const { teacher_id, school_code, date, periods } = req.body;

        if (!teacher_id || !date || !periods) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Upsert to Supabase
        const { data, error } = await supabase
            .from('daily_tasks')
            .upsert({
                teacher_id,
                school_code,
                date,
                periods,
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'teacher_id, date' // requires unique constraint in DB
            });

        if (error) {
            console.error("Supabase Error:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true, message: 'Tasks saved successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get Daily Task
app.get('/api/tasks/get', async (req, res) => {
    try {
        const { teacher_id, date } = req.query;

        if (!teacher_id || !date) {
            return res.status(400).json({ error: 'Missing teacher_id or date' });
        }

        const { data, error } = await supabase
            .from('daily_tasks')
            .select('*')
            .eq('teacher_id', teacher_id)
            .eq('date', date)
            .single();

        if (error && error.code !== 'PGRST116') { // PGRST116 means no rows found, which is fine
            console.error("Supabase Error:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true, data: data || null });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
// Task Users Auth - Login
app.post('/api/tasks/users/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

        const { data, error } = await supabase
            .from('task_users')
            .select('*')
            .eq('username', username)
            .eq('password', password) // In production, use hashed passwords. Using plain for simplicity as requested.
            .single();

        if (error || !data) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        res.json({ success: true, user: data });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Task Users Auth - Create (For Admin Panel)
app.post('/api/tasks/users/create', async (req, res) => {
    try {
        const { username, password, name, school_code } = req.body;
        if (!username || !password || !name) return res.status(400).json({ error: 'Missing required fields' });

        const { data, error } = await supabase
            .from('task_users')
            .insert([{ username, password, name, school_code }])
            .select()
            .single();

        if (error) {
            console.error(error);
            return res.status(400).json({ error: error.message });
        }

        res.json({ success: true, user: data });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
// Get All Task Users (For Admin Panel to display credentials)
app.get('/api/tasks/users/get_all', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('task_users')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error("Supabase Error:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true, data: data || [] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get All Tasks (For Admin Panel)
app.get('/api/tasks/get_all', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('daily_tasks')
            .select('*, task_users!inner(name, username)')
            .order('date', { ascending: false });

        if (error) {
            console.error("Supabase Error:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true, data: data });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ==========================================

// Initialize WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth({ 
        clientId: 'atteni-server', 
        dataPath: '.wwebjs_auth' 
    }),
    puppeteer: {
        // executablePath: '/usr/bin/chromium-browser', // Uncomment on Ubuntu if needed
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('SCAN THIS QR CODE WITH YOUR WHATSAPP:');
    qrcode.generate(qr, {small: true}); // {small: true} lagana zaroori hai!
});

client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
});

client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
});

client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
    console.log('Exiting process so PM2 can restart...');
    process.exit(1);
});

client.initialize().catch(err => {
    console.error('Failed to initialize WhatsApp client:', err);
    console.log('Exiting process so PM2 can restart...');
    process.exit(1);
});

const formatPhoneNumber = (number) => {
    let cleanNumber = number.replace(/\D/g, '');
    if (cleanNumber.length === 10) {
        cleanNumber = '91' + cleanNumber;
    }
    return cleanNumber;
};

const formatChatId = (number) => {
    return `${formatPhoneNumber(number)}@c.us`;
};

// Spintax logic to prevent Meta bans
const resolveSpintax = (text) => {
    let match;
    while ((match = /{([^{}]+)}/.exec(text))) {
        const options = match[1].split('|');
        const randomOption = options[Math.floor(Math.random() * options.length)];
        text = text.substring(0, match.index) + randomOption + text.substring(match.index + match[0].length);
    }
    return text;
};

const otpLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 3, // Limit each IP or Phone Number to 3 requests per `window`
    keyGenerator: (req) => {
        return req.body.phone || req.body.phoneNumber || 'unknown';
    },
    handler: (req, res) => {
        return res.status(429).json({ success: false, message: "Too Many Requests" });
    }
});

app.post('/api/request-otp', otpLimiter, async (req, res) => {
    const phoneNumber = req.body.phone || req.body.phoneNumber;
    const type = req.body.type || 'signup';
    console.log(`[API] /api/request-otp requested for: ${phoneNumber} (${type})`);
    
    if (!phoneNumber) {
        return res.status(400).json({ success: false, message: "phone number is required" });
    }
    
    try {
        // Gatekeeper Check (Multi-Tenancy Support)
        const rootDataSnap = await db.ref(`/artifacts/student-system-v2/public/data`).once('value');
        let found = false;
        
        if (rootDataSnap.exists()) {
            const rootData = rootDataSnap.val();
            
            if (type === 'forgot') {
                for (const schoolKey in rootData) {
                    if (schoolKey === 'parent_accounts' && rootData[schoolKey][phoneNumber]) found = true;
                    if (rootData[schoolKey] && rootData[schoolKey].parent_accounts && rootData[schoolKey].parent_accounts[phoneNumber]) found = true;
                    if (found) break;
                }
            } else if (type === 'signup') {
                for (const schoolKey in rootData) {
                    const studentsObj = (schoolKey === 'students') ? rootData[schoolKey] : (rootData[schoolKey] ? rootData[schoolKey].students : null);
                    if (studentsObj) {
                        for (const key in studentsObj) {
                            let phones = studentsObj[key].parentPhones || [];
                            if (!Array.isArray(phones)) phones = [phones];
                            if (phones.some(p => String(p).replace(/\D/g, '').slice(-10) === phoneNumber)) {
                                found = true;
                                break;
                            }
                        }
                    }
                    if (found) break;
                }
            }
        }

        if (!found) {
            console.log(`[API] /send-otp FAIL: User not found for ${phoneNumber} (${type})`);
            return res.status(404).json({ success: false, message: "no user found linked with this mobile no" });
        }

        // 2. Generate OTP & Expiry Time
        const generatedOTP = Math.floor(1000 + Math.random() * 9000).toString();
        const expiryTime = Date.now() + 300000; // Current time + 5 mins in milliseconds

        // 3. Save OTP to Firebase Database (THE NEW SHIFT)
        await db.ref(`/otps/${phoneNumber}`).set({
            code: generatedOTP,
            expiresAt: expiryTime
        });

        // 4. Check if OTP is disabled globally
        const disableOtpSnap = await db.ref('/artifacts/student-system-v2/public/data/system/disableOtp').once('value');
        const disableOtp = disableOtpSnap.val() === true;

        if (disableOtp) {
            console.log(`[BYPASS] OTP sending skipped because disableOtp is enabled. Code is: ${generatedOTP} for ${phoneNumber}`);
            return res.status(200).json({ success: true, message: "otp sent successfully (bypass)" });
        }

        // Send WhatsApp Message (original flow)
        if (!client.info) {
            return res.status(503).json({ success: false, error: 'WhatsApp client is not ready yet' });
        }
        
        const chatId = formatChatId(phoneNumber);
        const template = "{Hello|Hi|Greetings|Namaste}! {Your|Here is your} Atteni {OTP|login code|verification code} is: *{otp}*. {It is valid for 5 minutes.|Do not share this.|Please keep it secret.}";
        const rawMessage = template.replace('{otp}', generatedOTP);
        const message = resolveSpintax(rawMessage);

        await client.sendMessage(chatId, message);
        console.log(`OTP ${generatedOTP} sent to ${phoneNumber}`);

        return res.status(200).json({ success: true, message: "otp sent successfully" });

    } catch (error) {
        console.error("OTP Request Error:", error);
        if (error.message && error.message.includes('detached Frame')) {
            console.log("CRITICAL: Puppeteer frame detached. Restarting node process to recover...");
            setTimeout(() => process.exit(1), 1000);
        }
        return res.status(500).json({ success: false, message: "server error" });
    }
});

app.post('/api/verify-otp', async (req, res) => {
    const phoneNumber = req.body.phone || req.body.phoneNumber;
    const otp = req.body.code || req.body.otp;

    try {
        // 0. EMERGENCY MASTER BYPASS
        if (process.env.MASTER_OTP && otp && otp.toString() === process.env.MASTER_OTP) {
            console.log(`[EMERGENCY BYPASS] Master OTP used for ${phoneNumber}`);
            const customToken = await getAuth().createCustomToken('parent_' + phoneNumber);
            return res.status(200).json({ success: true, message: "verification succesfull (bypass)", token: customToken });
        }

        // 1. Fetch OTP from Firebase
        const otpRef = db.ref(`/otps/${phoneNumber}`);
        const snapshot = await otpRef.once('value');

        // Check if OTP was even requested
        if (!snapshot.exists()) {
            return res.status(404).json({ success: false, message: "no user found linked to this no or no OTP requested" });
        }

        const data = snapshot.val();

        // 2. Check Expiration
        if (Date.now() > data.expiresAt) {
            await otpRef.remove(); // Security check: Delete expired OTP immediately
            return res.status(400).json({ success: false, message: "otp expired try again" });
        }

        // 3. Check Exact Match
        if (data.code !== otp.toString()) {
            return res.status(400).json({ success: false, message: "otp mismatch try again" });
        }

        // 4. SUCCESS: OTP Validated! 
        await otpRef.remove(); // BURN IT. Never leave a used OTP in the database.
        
        const customToken = await getAuth().createCustomToken('parent_' + phoneNumber);
        return res.status(200).json({ success: true, message: "login succesfull", token: customToken });

    } catch (error) {
        console.error("OTP Verification Error:", error);
        return res.status(500).json({ success: false, message: "server error" });
    }
});

// --- NEW FCM BROADCAST ROUTE START ---
const { getMessaging } = require('firebase-admin/messaging');

app.post('/api/broadcast', async (req, res) => {
    const { title, message } = req.body;

    if (!title || !message) {
        return res.status(400).json({ 
            success: false, 
            error: 'Title aur message dono bhejna zaroori hai!' 
        });
    }

    try {
        const fcmPayload = {
            notification: {
                title: title,
                body: message
            },
            topic: 'all_users'
        };

        const response = await getMessaging().send(fcmPayload);
        
        console.log('[FCM] Broadcast successfully sent:', response);
        return res.status(200).json({ 
            success: true, 
            message: 'Broadcast sabko successfully bhej diya gaya!', 
            response 
        });
    } catch (error) {
        console.error('[FCM] Error sending broadcast:', error);
        return res.status(500).json({ 
            success: false, 
            error: 'Notification bhejte waqt server par error aaya.' 
        });
    }
});
// --- NEW FCM BROADCAST ROUTE END ---

// --- FIREBASE CONFIG ROUTE START ---
app.get('/api/firebase-config', (req, res) => {
    res.json({
        apiKey: "AIzaSyBC3tfhCq53pA2kNJtL8GFsC8F-OSCaJ9Q",
        authDomain: "buspro-4767d.firebaseapp.com",
        databaseURL: "https://buspro-4767d-default-rtdb.firebaseio.com",
        projectId: "buspro-4767d",
        storageBucket: "buspro-4767d.firebasestorage.app",
        messagingSenderId: "772721278896",
        appId: "1:772721278896:android:84df6b64cc19d5772c2075"
    });
});
// --- FIREBASE CONFIG ROUTE END ---

// Start Express Server
app.listen(port, () => {
    console.log(`OTP Server running on http://localhost:${port}`);
    console.log('Waiting for WhatsApp client to initialize...');
});

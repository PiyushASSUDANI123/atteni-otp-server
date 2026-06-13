require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const rateLimit = require('express-rate-limit');

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

// Initialize WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    puppeteer: {
        executablePath: '/usr/bin/chromium-browser', 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

client.on('qr', (qr) => {
    console.log('SCAN THIS QR CODE WITH YOUR WHATSAPP:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
});

client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
});

client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
});

client.initialize();

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
        // Gatekeeper Check
        if (type === 'forgot') {
            const userSnap = await db.ref(`/artifacts/student-system-v2/public/data/parent_accounts/${phoneNumber}`).once('value');
            if (!userSnap.exists()) {
                console.log(`[API] /send-otp FAIL: User not found in parent_accounts for ${phoneNumber}`);
                return res.status(404).json({ success: false, message: "no user found linked with this mobile no" });
            }
        } else if (type === 'signup') {
            const studentsSnap = await db.ref(`/artifacts/student-system-v2/public/data/students`).once('value');
            let found = false;
            if (studentsSnap.exists()) {
                const students = studentsSnap.val();
                for (const key in students) {
                    let phones = students[key].parentPhones || [];
                    if (!Array.isArray(phones)) phones = [phones];
                    if (phones.some(p => String(p).replace(/\D/g, '').slice(-10) === phoneNumber)) {
                        found = true;
                        break;
                    }
                }
            }
            if (!found) {
                console.log(`[API] /send-otp FAIL: User not found in students for ${phoneNumber}`);
                return res.status(404).json({ success: false, message: "no user found linked with this mobile no" });
            }
        }

        // 2. Generate OTP & Expiry Time
        const generatedOTP = Math.floor(1000 + Math.random() * 9000).toString();
        const expiryTime = Date.now() + 300000; // Current time + 5 mins in milliseconds

        // 3. Save OTP to Firebase Database (THE NEW SHIFT)
        await db.ref(`/otps/${phoneNumber}`).set({
            code: generatedOTP,
            expiresAt: expiryTime
        });

        // 4. Send WhatsApp Message (Tera whatsapp-web.js logic yahan aayega)
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

// Start Express Server
app.listen(port, () => {
    console.log(`OTP Server running on http://localhost:${port}`);
    console.log('Waiting for WhatsApp client to initialize...');
});

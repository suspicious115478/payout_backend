const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiting
const rateLimiter = new RateLimiterMemory({
  keyGenerator: (req) => req.ip || req.connection.remoteAddress,
  points: 100, // Increased for production
  duration: 60, // per 60 seconds
});

// Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Render के लिए CSP disable करें
  crossOriginEmbedderPolicy: false
}));

// CORS settings for production
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000', 
      'http://127.0.0.1:3000', 
      'http://localhost:5500', 
      'http://127.0.0.1:5500', 
      'http://localhost:8080', 
      'http://127.0.0.1:8080',
      'https://your-frontend-domain.onrender.com', // अपना frontend domain डालें
      /\.onrender\.com$/ // All Render domains
    ];
    
    if (allowedOrigins.some(allowedOrigin => {
      if (typeof allowedOrigin === 'string') {
        return origin === allowedOrigin;
      } else if (allowedOrigin instanceof RegExp) {
        return allowedOrigin.test(origin);
      }
      return false;
    })) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting middleware
app.use(async (req, res, next) => {
  try {
    await rateLimiter.consume(req.ip || req.connection.remoteAddress);
    next();
  } catch (rejRes) {
    res.status(429).json({
      success: false,
      message: 'Too many requests, please try again later.'
    });
  }
});

// Auto-configuration endpoint
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    backendUrl: `${req.protocol}://${req.get('host')}/api/send-email`,
    batchUrl: `${req.protocol}://${req.get('host')}/api/send-batch`,
    message: 'Backend automatically configured for Render'
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Email transporter configuration
let transporter;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
} else if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  // Gmail configuration (recommended for ease of use)
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
} else {
  console.warn('No email configuration found. Emails will not be sent.');
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Payment Slip Backend is running on Render',
    emailConfigured: !!transporter,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Email sending endpoint
app.post('/api/send-email', async (req, res) => {
  try {
    const { to_email, subject, message } = req.body;

    // Validate request
    if (!to_email || !subject || !message) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: to_email, subject, or message'
      });
    }

    // Check if email is configured
    if (!transporter) {
      return res.status(500).json({
        success: false,
        message: 'Email service is not configured on the server'
      });
    }

    // Send email
    const mailOptions = {
      from: process.env.FROM_EMAIL || process.env.GMAIL_USER,
      to: to_email,
      subject: subject,
      text: message,
      html: message.replace(/\n/g, '<br>')
    };

    const info = await transporter.sendMail(mailOptions);
    
    console.log('Email sent successfully:', info.messageId);
    
    res.json({
      success: true,
      message: 'Email sent successfully',
      messageId: info.messageId
    });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send email: ' + error.message
    });
  }
});

// Batch email sending endpoint
app.post('/api/send-batch', async (req, res) => {
  try {
    const { emails } = req.body;

    if (!emails || !Array.isArray(emails)) {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid emails array'
      });
    }

    if (!transporter) {
      return res.status(500).json({
        success: false,
        message: 'Email service is not configured on the server'
      });
    }

    const results = [];
    
    for (const emailData of emails) {
      try {
        const { to_email, subject, message, index } = emailData;
        
        if (!to_email || !subject || !message) {
          results.push({
            index: index || -1,
            success: false,
            message: 'Missing required fields'
          });
          continue;
        }

        const mailOptions = {
          from: process.env.FROM_EMAIL || process.env.GMAIL_USER,
          to: to_email,
          subject: subject,
          text: message,
          html: message.replace(/\n/g, '<br>')
        };

        const info = await transporter.sendMail(mailOptions);
        results.push({
          index: index || -1,
          success: true,
          message: 'Email sent successfully',
          messageId: info.messageId
        });
        
        // Add a small delay between emails to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (error) {
        console.error('Error sending email to:', emailData.to_email, error);
        results.push({
          index: emailData.index || -1,
          success: false,
          message: 'Failed to send email: ' + error.message
        });
      }
    }

    res.json({
      success: true,
      message: 'Batch email processing completed',
      results
    });
  } catch (error) {
    console.error('Error in batch email sending:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process batch emails: ' + error.message
    });
  }
});

// Render specific health check
app.get('/_health', (req, res) => {
  res.status(200).send('OK');
});

// Handle 404
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server Error:', error);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Payment Slip Backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server gracefully');
  process.exit(0);
});

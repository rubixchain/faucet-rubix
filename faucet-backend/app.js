require('dotenv').config();

const express = require('express');
const fs = require('fs-extra');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet'); // for security headers
const app = express();

const port = process.env.SERVER_PORT;
if (port === undefined) {
    console.error("SERVER_PORT env was not provided")
    return
}

const crypto = require('crypto');
const axios = require('axios');
const counterFilePath = 'counter.json';
const dbFilePath = 'counter.db';

// Initialize database
const db = new sqlite3.Database(dbFilePath, (err) => {
    if (err) {
        console.error('Failed to connect to database:', err);
    } else {
        console.log('Connected to SQLite database.');
        db.run(`CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            timestamp INTEGER
        )`);
    }
});

function calculateSHA3_256Hash(number) {
    // Convert number to string
    const numberString = number.toString();
    
    // Calculate SHA3-256 hash
    const hash = crypto.createHash('sha3-256').update(numberString, 'utf8').digest('hex');
    
    return hash;
}

// Function to read the counter value from the file
const readCounterFromFile = async () => {
    try {
        const data = await fs.readFile(counterFilePath, 'utf8');
        return JSON.parse(data).counter;
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File does not exist, return initial counter value of 0
            return 0;
        } else {
            throw error;
        }
    }
};

// Function to write the counter value to the file
const writeCounterToFile = async (counter) => {
    const data = { counter };
    await fs.writeFile(counterFilePath, JSON.stringify(data, null, 2));
};

// Initialize the counter value
let counter = 0;

const initializeCounter = async () => {
    counter = await readCounterFromFile();
};

const sourceIp = process.env.ALLOWED_IP
const origin = process.env.ORIGIN

app.use(express.json());
app.use(cors({
    origin: origin,
    methods: ['GET', 'POST','OPTIONS'],
    allowedHeaders: ['Content-Type'],
}));
// Security headers
app.use(helmet());

// Rate limiter for the /increment endpoint
const limiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 60 Mins
    max: 200, // Limit each IP to 200 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
});
app.use('/increment', (req, res, next) => {
    const source_ip = req.ip; // Get the requester's IP address
    if (source_ip === sourceIp) {
        next(); // Skip the rate limiter for this IP
    } else {
        limiter(req, res, next); // Apply the rate limiter
    }
});

const requestTimeoutInMilliSeconds = process.env.REQUEST_TIMEOUT_IN_SECONDS * 1000

// Increment the counter and save it to the file
app.post('/increment', async (req, res) => {
    const nodeAddress = process.env.RUBIX_NODE_ADDRESS
    if (nodeAddress === "") {
        return res.status(500).send('RUBIX_NODE_ADDRESS is not set')
    }

    const { username } = req.body;

    if (!username || typeof username !== 'string') {
        return res.status(400).send('Username is required and must be a string');
    }

    const currentTime = Date.now();

    db.get('SELECT timestamp FROM users WHERE username = ?', [username], (err, row) => {
        if (err) {
            return res.status(500).send('Database error');
        }

        if (row) {
            const lastRequestTime = row.timestamp;
            if (currentTime - lastRequestTime < requestTimeoutInMilliSeconds) {
                return res.status(429).send('Request denied. Try again after one hour.');
            }
        }

        // Update timestamp and increment counter
        db.run('REPLACE INTO users (username, timestamp) VALUES (?, ?)', [username, currentTime], async (err) => {
            if (err) {
                return res.status(500).send('Database error');
            }

            counter++;
            await writeCounterToFile(counter);
            const hash = calculateSHA3_256Hash(counter);
            res.send(`Token value: ${hash}`);
        });

        const axios = require('axios');

        // First API URL and data
        const rbtTransferAPIObj = new URL('/api/initiate-rbt-transfer', nodeAddress)
        const rbtTransferAPIUrl = rbtTransferAPIObj.href;
        const rbtTransferAPIRequest = {
          comment: "",
          receiver: username,
          sender: "bafybmiftqpvkq6sibrpjr3biallzbrmdwumlkwa37spo7iwdaxqpcpgdgm",
          tokenCount: 1.0,
          type: 2
        };
        
        // Second API URL
        const signatureResponseObj = new URL('/api/signature-response', nodeAddress)
        const signatureResponseAPIUrl = signatureResponseObj.href;
        
        // Make the first API request
        axios.post(rbtTransferAPIUrl, rbtTransferAPIRequest, {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        })
        .then(response => {
          // Extract data from the first response
          const id = response.data.result.id;

          console.log('id:', id);
        
          // Prepare the second request data using the response from the first request
          const secondRequestData = {
            id: id, // Replace with actual key from first response
            password: 'mypassword'
          };
        
          // Make the second API request
          return axios.post(signatureResponseAPIUrl, secondRequestData, {
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            }
          });
        })
        .then(response => {
          // Handle the response from the second API request
          console.log('Second API Response:', response.data);
        })
        .catch(error => {
          // Handle errors from either request
          console.error('Error:', error);
        });

    });
});

// Start the server after initializing the counter
initializeCounter().then(() => {
    app.listen(port, () => {
        console.log(`Server is running on http://localhost:${port}`);
    });
}).catch(err => {
    console.error('Failed to initialize the counter:', err);
});
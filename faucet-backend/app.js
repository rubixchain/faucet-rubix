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
        console.log("sdasasd: ", data)
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
        next()
    }
});

const requestTimeoutInMilliSeconds = process.env.REQUEST_TIMEOUT_IN_SECONDS * 1000

// Increment the counter and save it to the file
app.post('/increment', async (req, res) => {
    const nodeAddress = process.env.RUBIX_NODE_ADDRESS
    if (nodeAddress === "") {
        console.error('RUBIX_NODE_ADDRESS is not set')
        res.status(500).send({"error": "internal server error"})
    }

    const { username } = req.body;

    if (!username || typeof username !== 'string') {
        res.status(400).send({'error': 'username is required and must be a string'});
    }

    const currentTime = Date.now();

    db.get('SELECT timestamp FROM users WHERE username = ?', [username], (err, row) => {
        if (err) {
            res.status(500).send({"error": 'Database error'});
        }

        if (row) {
            const lastRequestTime = row.timestamp;
            if (currentTime - lastRequestTime < requestTimeoutInMilliSeconds) {
                res.status(429).send({"error": 'Request denied. Try again after one hour.'});
            }
        }

        // Update timestamp and increment counter
        db.run('REPLACE INTO users (username, timestamp) VALUES (?, ?)', [username, currentTime], async (err) => {
            if (err) {
                res.status(500).send({"error": 'Database error'});
            }

            counter++;
            await writeCounterToFile(counter);
            const hash = calculateSHA3_256Hash(counter);
        });

        const axios = require('axios');

        // First API URL and data
        const rbtTransferAPIObj = new URL('/api/initiate-rbt-transfer', nodeAddress)
        const rbtTransferAPIUrl = rbtTransferAPIObj.href;
        const rbtTransferAPIRequest = {
          comment: "",
          receiver: username,
          sender: process.env.FAUCET_DID,
          tokenCount: parseFloat(process.env.FAUCET_REQUEST_AMOUNT),
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
          const apiRespBody = response.data;
          if (!apiRespBody["status"]) {
            console.error("error occured while calling RBT Transfer API, error: ", apiRespBody["message"])
            res.status(500).send({"error": "internal server error"})
            return
          }

          const id = response.data.result.id;

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
          const reqAmtValue = parseFloat(process.env.FAUCET_REQUEST_AMOUNT).toFixed(3)
          console.log('Second API Response:', response.data);
          
          res.status(200).send({
            "message": `${reqAmtValue} RBT has been transferred successfully to ${username}`
          })
        })
        .catch(error => {
          // Handle errors from either request
          console.error('Error:', error);
            res.send(500).send({
                "error": `failed to transfer token to ${username}, err: ${error}`
            })
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
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin SDK
const serviceAccount = require("./store-voice-firebase-adminsdk-4ps9i-56b5cdd10e.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "reportbutton-bdc25.appspot.com",
});

const bucket = admin.storage().bucket();

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let isStreaming = false;
let currentDeviceId;
let isDeviceIdReceived = false;
let deviceChunksMap = new Map();

wss.on("connection", (ws) => {
  console.log("WebSocket connected");

  ws.on("message", async (message) => {
    const messageStr = message.toString(); // Convert buffer to string

    // Check if the message is "START_OF_AUDIO_DATA"
    if (messageStr === "START_OF_AUDIO_DATA") {
      console.log("Received start of audio data signal.");
      isStreaming = true;
      isDeviceIdReceived = false; // Reset flag for receiving device ID
      deviceChunksMap = new Map(); // Clear previous data chunks
      return;
    }

    // Check if the message is "END_OF_AUDIO_STREAM"
    if (messageStr === "END_OF_AUDIO_STREAM") {
      console.log("Received end of audio stream signal.");
      isStreaming = false;
      if (currentDeviceId && deviceChunksMap.has(currentDeviceId)) {
        const timestamp = new Date();
        console.log(
          `Processing completed for device ${currentDeviceId} at ${timestamp}`
        );

        const chunks = deviceChunksMap.get(currentDeviceId);
        if (chunks && chunks.length > 0) {
          const concatenatedBuffer = Buffer.concat(chunks);

          const fileName = `audio_${uuidv4()}.wav`;

          convertPCMToWAV(concatenatedBuffer, fileName, () => {
            console.log(`WAV file created: ${fileName}`);
            uploadFileToStorage(fileName, currentDeviceId, timestamp);
          });
        }

        deviceChunksMap.delete(currentDeviceId);
      } else {
        console.log("No data found for current device ID.");
      }
      return;
    }

    // If it's not "START_OF_AUDIO_DATA" or "END_OF_AUDIO_STREAM",
    // and streaming has begun, assume it's the device ID or audio data
    if (isStreaming) {
      if (!isDeviceIdReceived) {
        currentDeviceId = messageStr;
        console.log("Received device ID:", currentDeviceId);
        isDeviceIdReceived = true;
        return;
      }

      // Handle audio data
      console.log(
        `Received binary message from device ${currentDeviceId} at ${new Date()}`
      );

      if (!deviceChunksMap.has(currentDeviceId)) {
        deviceChunksMap.set(currentDeviceId, []);
      }

      const chunks = deviceChunksMap.get(currentDeviceId);
      chunks.push(message);
    }
  });

  ws.on("close", () => {
    console.log(`WebSocket disconnected`);
    isStreaming = false;
    isDeviceIdReceived = false;
    deviceChunksMap = new Map(); // Clear all data chunks
  });

  ws.on("error", (err) => {
    console.error(`WebSocket error:`, err);
    isStreaming = false;
    isDeviceIdReceived = false;
    deviceChunksMap = new Map(); // Clear all data chunks
  });
});
function convertPCMToWAV(pcmBuffer, fileName, callback) {
  const sampleRate = 6000;
  const channels = 1;
  const bitDepth = 16;
  const amplificationFactor = 15.0; // Amplify the audio by 2 times

  // Apply amplification
  const amplifiedBuffer = Buffer.alloc(pcmBuffer.length);
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    let sample = pcmBuffer.readInt16LE(i);
    sample = Math.max(-32768, Math.min(32767, sample * amplificationFactor));
    amplifiedBuffer.writeInt16LE(sample, i);
  }

  const dataSize = amplifiedBuffer.length;
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  const wavBuffer = Buffer.concat([header, amplifiedBuffer]);

  fs.writeFile(fileName, wavBuffer, (err) => {
    if (err) {
      console.error("Error writing WAV file:", err);
    } else {
      callback(fileName);
    }
  });
}

function uploadFileToStorage(fileName, deviceId, timestamp) {
  const readStream = fs.createReadStream(fileName);

  const file = bucket.file(fileName);
  readStream
    .pipe(
      file.createWriteStream({
        metadata: {
          contentType: "audio/wav",
          metadata: {
            deviceId,
            timestamp: timestamp.toISOString(),
          },
        },
      })
    )
    .on("error", (err) => {
      console.error("Error uploading file to Firebase Storage:", err);
    })
    .on("finish", async () => {
      console.log(`File uploaded to Firebase Storage: ${fileName}`);
      fs.unlinkSync(fileName);
    });
}

// Fetch audio files and metadata from Firebase Storage
app.get("/files", async (req, res) => {
  try {
    const [files] = await bucket.getFiles();
    const fileMetadata = await Promise.all(
      files.map(async (file) => {
        const [metadata] = await file.getMetadata();
        return {
          name: file.name,
          deviceId: metadata.metadata.deviceId,
          timestamp: metadata.metadata.timestamp,
          url: await file.getSignedUrl({
            action: "read",
            expires: "03-01-2500",
          }),
        };
      })
    );
    res.render("files", { audioFiles: fileMetadata });
  } catch (err) {
    console.error("Error fetching files from Firebase Storage:", err);
    res.status(500).send("Internal server error");
  }
});

app.use(express.static(path.join(__dirname, "public")));

server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});

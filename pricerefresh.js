var express = require('express');
var app = express();
var cors = require('cors');
const axios = require('axios');

// Function to fetch data from Chess.com
async function fetchChessData({username}) {
  try {
    const response = await axios.get(`https://api.chess.com/pub/player/${username}/stats`); 
    
    // Process the response as needed
    console.log('Fetched data from Chess.com:', response.data);
  } catch (error) {
    console.error('Error fetching data from Chess.com:', error);
  }
}

// Set an interval to fetch data every 60 seconds
setInterval(fetchChessData, 60 * 1000); // 60 seconds

module.exports = fetchChessData; // Export the function if needed for testing or other purposes

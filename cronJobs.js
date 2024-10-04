const cron = require('node-cron');
const pool = require('./database');  
const axios = require('axios');  

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Schedule a task to run every 15 minutes
cron.schedule('*/30 * * * *', async () => {
  try {
    console.log('Running a task every 15 minutes');

    // Fetch users from the database
    const usersResult = await pool.query('SELECT username FROM auth.users');
    const users = usersResult.rows;

    // Loop through each user and fetch their rating from Chess.com API
    for (const user of users) {
      const username = user.username;

      // Fetch user rating from Chess.com API
      const response = await axios.get(`https://api.chess.com/pub/player/${username}/stats`);
      const rating = response.data ;  
 
      const stock_price =  (rating.chess_rapid.last.rating+rating.chess_bullet.last.rating+rating.chess_blitz.last.rating)/300;
  

      // Update stock price in the stocks table for each user
      await pool.query('UPDATE stockdetails.stocks SET current_price = $1 WHERE stock_name = $2',
        [stock_price, username]  
      );

      console.log(`Updated stock price for user ${username} with rating ${rating}`);
      // Delay 2 seconds before making the next API call
      await delay(2000);
    }
    
    console.log('Finished updating stock prices for all users.');
  } catch (error) {
    console.error('Error executing cron job:', error);
  }
});

var express = require('express');
var app = express();
var cors = require('cors');
const axios = require('axios');
const pool = require('./database'); // Import the PostgreSQL connection pool
const bodyParser = require('body-parser'); // Middleware to parse request body

require('./cronJobs'); 

const jwt = require('jsonwebtoken');
const secretKey = '';  // Use a strong secret key

app.use(bodyParser.json()); // For parsing application/json
app.use(cors());

app.get('/', function (req, res) {
  res.send('Hello World!');
});

app.post('/signup', async function (req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  console.log("triggered Signup", username, password);
 

  try {
    // Start a transaction
    await pool.query('BEGIN');

    // Make an external API call to check if the user exists on chess.com
    const response = await axios.get(`https://www.chess.com/callback/user/popup/${username}`);

    console.log("response", response.data.flair.status);

    if (response.data.flair.status === "Chess Stonks") {
      // Insert user into the PostgreSQL database
      const insertUserQuery = 'INSERT INTO auth.users (username, password) VALUES ($1, $2) RETURNING id;';
      console.log("insertUserQuery", insertUserQuery);
      const userResult = await pool.query(insertUserQuery, [username, password]);

      // Get the rating of user and calcualte stock price
      const response = await axios.get(`https://api.chess.com/pub/player/${username}/stats`);
      const rating = response.data ;  
 
      const stock_price =  (rating.chess_rapid.last.rating+rating.chess_bullet.last.rating+rating.chess_blitz.last.rating)/300;

      // Insert corresponding stock data for the new user
      const insertStockQuery = `INSERT INTO stockdetails.stocks (stock_name, current_price, total_supply, available_supply) VALUES ($1, $2, $3, $4);`;

      const totalSupply = 200; // Set total supply
      const availableSupply = 200; // Initially, no stocks are available

      await pool.query(insertStockQuery, [username, stock_price, totalSupply, availableSupply]);

      // Insert corresponding finance data for the new user
      const insertFinanceQuery = `INSERT INTO auth.users_finances (username, cash, stock_money) VALUES ($1, $2, $3);`;
      const initialCash = 100.00; // Set initial cash
      const initialStockMoney = totalSupply * stock_price; // Set initial stock money

      await pool.query(insertFinanceQuery, [username, initialCash, initialStockMoney]);


      // Insert ownership record for the new user
      const insertOwnershipQuery = `INSERT INTO stockdetails.stocks_ownership (username, stock_name, stock_quantity) VALUES ($1, $2, $3);`;
      const amountOwned = totalSupply; // Assuming user owns all available stocks initially

      try {
        await pool.query(insertOwnershipQuery, [username, username, amountOwned]);
        console.log("Ownership data inserted successfully");
      } catch (ownershipError) {
        console.error('Error inserting into stocks_ownership:', ownershipError);
         
      }

      // Commit the transaction if everything is successful
      await pool.query('COMMIT');

      // Send a success response to the client
      return res.status(201).json({
        message: 'Signup successful!',
        userId: userResult.rows[0].id
      });
    } else {
      // Rollback the transaction if the external API check fails
      await pool.query('ROLLBACK');
      return res.status(400).json({ error: 'User is not valid for signup' });
    }
  } catch (error) {
    // Rollback the transaction in case of any error
    await pool.query('ROLLBACK');
    console.error('Error during signup:', error);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    // Release the client back to the pool
    
  }
});

 
// API to handle user login
app.post('/login', async (req, res) => {

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  try {
    // Query the auth.users table
    const query = 'SELECT * FROM auth.users WHERE username = $1';
    const result = await pool.query(query, [username]);

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    const user = result.rows[0];
 
    // Verify the password
    const isPasswordValid = password === user.password;
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }
 
    // Generate a JWT token
    const token = jwt.sign(
      { username: user.username}, secretKey);


    // Successful login
    res.json({ message: 'Login successful!', token: token, username: user.username });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

app.post('/trade', async (req, res) => {
  const { username, stockname, quantity, action } = req.body;

  if (!username || !stockname || !quantity || !action) {
    return res.status(400).json({ error: 'Username, stockname, quantity, and action are required' });
  }
 

  try {
    await pool.query('BEGIN');  // Start the transaction

    // Get the stock details for the stock
    const stockQuery = 'SELECT available_supply, total_supply, current_price FROM stockdetails.stocks WHERE stock_name = $1;';
    const stockResult = await pool.query(stockQuery, [stockname]);

    if (stockResult.rows.length === 0) {
      await pool.query('ROLLBACK');  // Rollback if stock not found
      return res.status(404).json({ error: 'Stock not found' });
    }

    const { available_supply, total_supply, current_price } = stockResult.rows[0];
    let updatedSupply;

    if (action === 'buy') {
      // Check if enough stocks are available
      if (available_supply < quantity) {
        await pool.query('ROLLBACK');  // Rollback if not enough stocks
        return res.status(400).json({ error: 'Not enough stocks available' });
      }
      updatedSupply = available_supply - quantity;
    } else if (action === 'sell') {
      // Ensure user doesn't exceed total supply when selling
      updatedSupply = available_supply + quantity;
      if (updatedSupply > total_supply) {
        await pool.query('ROLLBACK');  // Rollback if quantity exceeds total supply
        return res.status(400).json({ error: 'Quantity exceeds total supply' });
      }
    }

    // Update the available supply in the stockdetails.stocks table
    const updateStockQuery = `UPDATE stockdetails.stocks SET available_supply = $1 WHERE stock_name = $2;`;
    await pool.query(updateStockQuery, [updatedSupply, stockname]);

    // Check if the user already has a record for this stock
    const userStockQuery = `SELECT stock_quantity FROM stockdetails.stocks_ownership WHERE username = $1 AND stock_name = $2;`;
    const userStockResult = await pool.query(userStockQuery, [username, stockname]);

    let updatedUserStockQuantity;
    if (userStockResult.rows.length > 0) {
      // User already has this stock, so update the stock quantity
      if (action === 'buy') {
        updatedUserStockQuantity = userStockResult.rows[0].stock_quantity + quantity;
      } else if (action === 'sell') {
        if (userStockResult.rows[0].stock_quantity < quantity) {
          await pool.query('ROLLBACK');  // Rollback if not enough stocks to sell
          return res.status(400).json({ error: 'You do not have enough stocks to sell' });
        }
        updatedUserStockQuantity = userStockResult.rows[0].stock_quantity - quantity;

        // If the updated stock quantity is 0, remove the row from stocks_ownership
        if (updatedUserStockQuantity === 0) {
          const deleteUserStockQuery = 'DELETE FROM stockdetails.stocks_ownership WHERE username = $1 AND stock_name = $2;';
          await pool.query(deleteUserStockQuery, [username, stockname]);
        } else {
          // Otherwise, update the user's stock quantity
          const updateUserStockQuery = 'UPDATE stockdetails.stocks_ownership SET stock_quantity = $1 WHERE username = $2 AND stock_name = $3;';
          await pool.query(updateUserStockQuery, [updatedUserStockQuantity, username, stockname]);
        }

      }

      // Update the user's stock quantity
      const updateUserStockQuery = `UPDATE stockdetails.stocks_ownership SET stock_quantity = $1 WHERE username = $2 AND stock_name = $3;`;
      await pool.query(updateUserStockQuery, [updatedUserStockQuantity, username, stockname]);
    } else {
      // If no record exists, insert a new row for the user
      if (action === 'buy') {
        const insertUserStockQuery = `INSERT INTO stockdetails.stocks_ownership (username, stock_name, stock_quantity) VALUES ($1, $2, $3);`;
        await pool.query(insertUserStockQuery, [username, stockname, quantity]);
      } else {
        await pool.query('ROLLBACK');  // Rollback if the user doesn't own the stock when selling
        return res.status(400).json({ error: 'You do not own this stock' });
      }
    }

    // Get the user's financial data
    const financeQuery = `SELECT cash, stock_money FROM auth.users_finances WHERE username = $1;`;
    const financeResult = await pool.query(financeQuery, [username]);

    if (financeResult.rows.length === 0) {
      await pool.query('ROLLBACK');  // Rollback if user financial data is not found
      return res.status(404).json({ error: 'User financial data not found' });
    }

    let { cash, stock_money } = financeResult.rows[0];
    const totalPrice = current_price * quantity;

    // Adjust user's cash and stock_money based on action
    if (action === 'buy') {
      if (cash < totalPrice) {
        await pool.query('ROLLBACK');  // Rollback if not enough cash
        return res.status(400).json({ error: 'Not enough cash to buy stocks' });
      }
      cash -= totalPrice;
      stock_money += totalPrice;
    } else if (action === 'sell') {
      cash += totalPrice;
      stock_money -= totalPrice;
    }

    // Update the user's financial data
    const updateFinanceQuery = `UPDATE auth.users_finances SET cash = $1, stock_money = $2, last_updated = CURRENT_TIMESTAMP WHERE username = $3;`;
    await pool.query(updateFinanceQuery, [cash, stock_money, username]);

    await pool.query('COMMIT');  // Commit the transaction

    // Respond to the client
    res.status(200).json({
      message: `Stocks ${action} operation successful`,
      available_supply: updatedSupply,
      current_price,
      updated_finances: {
        cash,
        stock_money
      }
    });

  } catch (error) {
    await pool.query('ROLLBACK');  // Rollback the transaction in case of error
    console.error(`Error during stock ${action}:`, error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    
  }
});

app.get('/standings', async(req,res) => {
  try {
    // Query to fetch username, cash, stock_money and calculate net worth
    const query = `SELECT username, cash, stock_money, (cash + stock_money) AS net_worth FROM auth.users_finances;`;
    const result = await pool.query(query);

    console.log(result);

    // Check if any records were found
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No financial data found' });
    }
    // Return the results as JSON
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching net worth:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// API to fetch stock details
app.get('/stocks', async (req, res) => {
  try {
    const result = await pool.query('SELECT stock_name, current_price, available_supply FROM stockdetails.stocks');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching stock data:', error);
    res.status(500).send('Internal Server Error');
  }
});


// API to fetch user financial information
app.get('/finance', async (req, res) => { 

  const { username } = req.query;

  try {
    const query = `SELECT cash, stock_money, last_updated FROM auth.users_finances WHERE username = $1`;
    const result = await pool.query(query, [username]);

    const priceQuery = `SELECT current_price from stockdetails.stocks WHERE stock_name = $1`;
    const priceResult = await pool.query(priceQuery, [username]);

  
    if (result.rows.length > 0) {
      const userFinances = result.rows[0];
      const stockPrice = priceResult.rows[0];

      res.json({
        success: true,
        data: {
          netWorth: parseFloat(userFinances.cash) + parseFloat(userFinances.stock_money),
          totalCash: parseFloat(userFinances.cash),
          totalStockWorth: parseFloat(userFinances.stock_money), 
          stockValue: parseFloat(stockPrice.current_price),
          amountInvested: parseFloat(stockPrice.amountInvested)
        }
      });
    } else {
      res.status(404).json({ success: false, message: 'Details not found' });
    }
  } catch (error) {
    console.error('Error fetching user finances:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// API to fetch user stock holdings
app.get('/holdings', async (req, res) => {
  const { username } = req.query; // Get the username from the query parameters

  try {
    // Query to fetch the stock holdings for the given username
    const query = `SELECT stock_name, stock_quantity , amount_invested AS invested_amount FROM stockdetails.stocks_ownership WHERE username = $1`;
    const result = await pool.query(query, [username]);

    console.log("ressssssssss:",result);

    // Check if there are holdings
    if (result.rows.length > 0) {
      const holdings = await Promise.all(result.rows.map(async (holding) => {
        // Assume you have a function to get the current stock price
        const stockPriceQuery = `SELECT current_price FROM stockdetails.stocks WHERE stock_name = $1`;
        const priceResult = await pool.query(stockPriceQuery, [holding.stock_name]);
  
        const currentPrice =  priceResult.rows[0].current_price;

        // Calculate profit
        const profit = (currentPrice * holding.stock_quantity) - holding.invested_amount;

        return {
          stock_name: holding.stock_name,
          stock_quantity: holding.stock_quantity,
          invested_amount: holding.invested_amount,
          profit: profit,
        };
      }));

      res.json({
        success: true,
        data: holdings,
      });
    } else {
      res.status(404).json({ success: false, message: 'No holdings found for this user.' });
    }
  } catch (error) {
    console.error('Error fetching stock holdings:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// Fetch the watchlist
app.get('/watchlist/:username', async (req, res) => { 
  try {
    const { username } = req.params;  

    const query = 'SELECT w.stock_name, s.available_supply, s.current_price FROM auth.watchlist w JOIN stockdetails.stocks s ON w.stock_name = s.stock_name WHERE w.username = $1';
    const result = await pool.query(query,[username]);

    console.log("getres:",result);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching watchlist:', error);
    res.status(500).send('Server error');
  }
});

// Add a stock to the watchlist
app.post('/watchlist/add/:username/:stock_name', async (req, res) => {
  
  const { username, stock_name } = req.params;

  if (!username || !stock_name) {
    return res.status(400).send('Username and stock name are required');
  }

  // Check if the stock exists in the stock table
  const checkStockQuery = 'SELECT * FROM stockdetails.stocks WHERE stock_name = $1';
  const stockResult = await pool.query(checkStockQuery, [stock_name]);

  if (stockResult.rowCount === 0) {
    return res.status(404).send('Stock not found');
  }

  // Check if the stock is already in the user's watchlist
  const checkWatchlistQuery = 'SELECT * FROM auth.watchlist WHERE username = $1 AND stock_name = $2';
  const watchlistResult = await pool.query(checkWatchlistQuery, [username, stock_name]);

  if (watchlistResult.rowCount > 0) {
    return res.status(409).send('Stock already exists in the watchlist');
  }

  try {
    // Use RETURNING * to get the inserted row
    const query = 'INSERT INTO auth.watchlist (username, stock_name) VALUES ($1, $2) RETURNING *';
    const result = await pool.query(query, [username, stock_name]);

    console.log("Inserted row:", result.rows[0]);

    // Send the inserted row in the response
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error adding stock to watchlist:', error);
    res.status(500).send('Server error');
  }
});


// Remove a stock from the watchlist
app.delete('/watchlist/:username/:stock_name', async (req, res) => {
  const { username, stock_name } = req.params;

  try {
    const query = 'DELETE FROM auth.watchlist WHERE username = $1 and stock_name = $2';
    const result = await pool.query(query,[username,stock_name]);

    if (result.rowCount === 0) {
      return res.status(404).send('Stock not found');
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error removing stock from watchlist:', error);
    res.status(500).send('Server error');
  }
});



app.listen(3000, function () {
  console.log('Example app listening on port 3000!');
});

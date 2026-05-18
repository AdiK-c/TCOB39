const fetch = require("node-fetch");
const TOKEN = "YOUR_ACCESS_TOKEN";

async function Log(stack, level, pkg, message) {

  try {

    const response = await fetch(
      "http://4.224.186.213/evaluation-service/logs",
      {

        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`
        },

        body: JSON.stringify({
          stack: stack,
          level: level,
          package: pkg,
          message: message
        })

      }
    );

    const data = await response.json();

    console.log(data);

  } catch (error) {

    console.log(error);

  }

}

module.exports = Log;

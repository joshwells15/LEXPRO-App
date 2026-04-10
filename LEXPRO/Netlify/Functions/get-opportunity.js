const https = require('https');

const GHL_API_KEY = 'pit-4e98487c-3f65-409c-a264-16352f97c01a';
const GHL_LOCATION_ID = 'R5PobkV1CRO23kz95yYB';

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method: 'GET', headers };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve({}); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const contactId = event.queryStringParameters?.contact_id;
  if (!contactId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'contact_id required' }) };
  }

  try {
    const data = await httpsGet(
      'services.leadconnectorhq.com',
      `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}&status=open`,
      {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    );
    const opps = data.opportunities || [];
    const opp = opps.find(o => o.status === 'open') || opps[0];
    if (opp) {
      return { statusCode: 200, headers, body: JSON.stringify({ opportunity_id: opp.id, pipeline_id: opp.pipelineId }) };
    } else {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'no opportunity found' }) };
    }
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

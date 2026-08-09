// LEXPRO :: update-contract.js (team-app port)
// Saves Under Contract updates/dates to GHL for seller or buyer side.
// FIX vs old showings version: buyer zip key corrected to
// buyer__subject_property_zip_code (verified at runtime by buyer-sync).

const GHL_API_KEY = process.env.GHL_API_KEY || 'pit-b2267e03-7ae0-43d3-9cd0-02fa58f3d730';
const GHL_LOCATION = 'R5PobkV1CRO23kz95yYB';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { contactId, side } = body;
  if (!contactId) return { statusCode: 400, body: JSON.stringify({ error: 'contactId is required' }) };
  if (!side || !['seller', 'buyer'].includes(side)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'side must be seller or buyer' }) };
  }

  const customFields = [];
  const fieldMap = side === 'seller'
    ? {
        transactions:           'seller_transactions',
        closing_gift_ordered:   'closing_gift_ordered',
        commission_amount:      'commission_amount',
        sales_price:            'sales_price',
        under_contract_date:    'under_contract',
        tentative_closing_date: 'tentative_closing',
        inspection_notice_days: 'inspection_notice_days',
        inspection_notice_resp: 'inspection_notice_response_days',
        appraisal_days:         'appraisal_days',
        title_days:             'title_days',
        financial_days:         'financial_days',
      }
    : {
        transactions:           'buyer_transactions',
        closing_gift_ordered:   'closing_gift_ordered',
        commission_amount:      'commission_amount',
        sales_price:            'sales_price',
        earnest_money:          'earnest_money_amount',
        street:                 'buyer__subject_property_street',
        city:                   'buyer__subject_property_city',
        state:                  'buyer__subject_property_state',
        zip:                    'buyer__subject_property_zip_code', // <- corrected key
        under_contract_date:    'under_contract',
        tentative_closing_date: 'tentative_closing',
        inspection_notice_days: 'inspection_notice_days',
        inspection_notice_resp: 'inspection_notice_response_days',
        appraisal_days:         'appraisal_days',
        title_days:             'title_days',
        financial_days:         'financial_days',
      };

  for (const [payloadKey, ghlKey] of Object.entries(fieldMap)) {
    const val = body[payloadKey];
    if (val !== undefined && val !== null && val !== '') {
      customFields.push({ key: ghlKey, field_value: String(val) });
    }
  }
  if (customFields.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No fields provided to update.' }) };
  }

  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
      },
      body: JSON.stringify({ locationId: GHL_LOCATION, customFields }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('GHL error:', JSON.stringify(data));
      return { statusCode: res.status, body: JSON.stringify({ error: data.message || 'GHL update failed' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, contactId }) };
  } catch (err) {
    console.error('update-contract error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};

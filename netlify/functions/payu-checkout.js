const crypto = require('crypto');
exports.handler = async (event) => {
  const { orderNum, total, email, name, phone, address, city } = JSON.parse(event.body);
  const MERCHANT = process.env.PAYU_MERCHANT_ID;
  const ACCOUNT  = process.env.PAYU_ACCOUNT_ID;
  const APIKEY   = process.env.PAYU_API_KEY;
  const TEST     = process.env.PAYU_TEST !== 'false';
  const sig = crypto.createHash('md5').update(`${APIKEY}~${MERCHANT}~${orderNum}~${parseFloat(total).toFixed(2)}~COP`).digest('hex');
  const redirectUrl = TEST
    ? 'https://sandbox.checkout.payulatam.com/ppp-web-gateway-payu/'
    : 'https://checkout.payulatam.com/ppp-web-gateway-payu/';
  const fields = {
    merchantId:MERCHANT, accountId:ACCOUNT,
    description:`Pedido FlexFK ${orderNum}`, referenceCode:orderNum,
    amount:parseFloat(total).toFixed(2), tax:'0', taxReturnBase:'0', currency:'COP',
    signature:sig, algorithmSignature:'MD5',
    buyerEmail:email, buyerFullName:name, buyerPhone:phone,
    shippingAddress:address, shippingCity:city, shippingCountry:'CO',
    responseUrl:`${process.env.URL}?payu_response=1`,
    confirmationUrl:`${process.env.URL}?payu_confirm=1`,
    test:TEST?'1':'0'
  };
  return { statusCode:200, body:JSON.stringify({redirectUrl, fields}) };
};
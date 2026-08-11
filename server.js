
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const Razorpay = require('razorpay');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const hasDb = Boolean(process.env.DATABASE_URL);
const pool = hasDb ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
}) : null;

const razorpay = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

const products = [
  {id:'areca-round',name:'Areca Palm Round Plate',material:'Areca Palm Leaf',price:8,unit:'plate',tag:'Bestseller',emoji:'🍽️',description:'Classic round plate crafted from naturally shed areca palm leaves. Heat-resistant, chemical-free, and elegantly textured.'},
  {id:'bagasse',name:'Sugarcane Bagasse Plate',material:'Sugarcane Fibre',price:6,unit:'plate',tag:'Eco Pick',emoji:'🥗',description:'Made from sugarcane waste fibre. Microwave-safe, oil-resistant, smooth white finish. Perfect for everyday use.'},
  {id:'bamboo',name:'Bamboo Fibre Plate',material:'Bamboo Pulp',price:12,unit:'plate',tag:'Premium',emoji:'🎋',description:'Premium lightweight plates with a silky-smooth finish. Ideal for weddings, fine dining, and upscale events.'}
];

function ensureStore(){
  fs.mkdirSync(DATA_DIR,{recursive:true});
  if(!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE,JSON.stringify({orders:[],quotes:[],contacts:[]},null,2));
}
function readStore(){ensureStore();return JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))}
function writeStore(data){ensureStore();fs.writeFileSync(DATA_FILE,JSON.stringify(data,null,2))}
function makeId(prefix){return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`}
function clean(v,max=500){return String(v ?? '').trim().slice(0,max)}
function validEmail(v){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)}
function totalFor(items){
  return items.reduce((sum,item)=>{
    const p=products.find(x=>x.id===item.productId);
    const qty=Math.max(1,Math.min(100000,Number(item.quantity)||0));
    return sum+(p?p.price*qty:0);
  },0)
}
async function initDb(){
  if(!pool)return;
  await pool.query(`CREATE TABLE IF NOT EXISTS orders(
    id TEXT PRIMARY KEY, customer JSONB NOT NULL, items JSONB NOT NULL,
    total NUMERIC NOT NULL, payment_method TEXT, payment_status TEXT,
    status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS quotes(
    id TEXT PRIMARY KEY, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS contacts(
    id TEXT PRIMARY KEY, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
async function saveOrder(o){
  if(pool){
    await pool.query(
      'INSERT INTO orders(id,customer,items,total,payment_method,payment_status,status) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [o.id,o.customer,o.items,o.total,o.paymentMethod,o.paymentStatus,o.status]
    ); return;
  }
  const s=readStore(); s.orders.push(o); writeStore(s);
}
async function getOrder(orderId){
  if(pool){
    const r=await pool.query('SELECT * FROM orders WHERE id=$1',[orderId]);
    if(!r.rows[0])return null;
    const x=r.rows[0];
    return {...x,customer:x.customer,items:x.items};
  }
  return readStore().orders.find(o=>o.id===orderId)||null;
}
async function updateOrderStatus(orderId,status){
  if(pool){
    const r=await pool.query('UPDATE orders SET status=$1 WHERE id=$2 RETURNING *',[status,orderId]);
    return r.rows[0]||null;
  }
  const s=readStore(); const o=s.orders.find(x=>x.id===orderId);
  if(o)o.status=status; writeStore(s); return o||null;
}
async function saveGeneric(table,recordId,payload){
  if(pool){await pool.query(`INSERT INTO ${table}(id,payload) VALUES($1,$2)`,[recordId,payload]);return}
  const s=readStore(); s[table].push({id:recordId,...payload,createdAt:new Date().toISOString()}); writeStore(s);
}
function admin(req,res,next){
  if(!process.env.ADMIN_KEY || req.header('x-admin-key')!==process.env.ADMIN_KEY)
    return res.status(401).json({error:'Unauthorized'});
  next();
}

app.use(helmet({contentSecurityPolicy:false}));
app.use(cors({origin:process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(x=>x.trim()) : true}));
app.use(express.json({limit:'200kb'}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(__dirname));

app.get('/api/health',(req,res)=>res.json({ok:true,service:'paraslis',storage:hasDb?'postgresql':'json',razorpayConfigured:Boolean(razorpay)}));
app.get('/api/products',(req,res)=>res.json({products}));
app.get('/api/products/:id',(req,res)=>{
  const p=products.find(x=>x.id===req.params.id);
  if(!p)return res.status(404).json({error:'Product not found'});
  res.json(p);
});

app.post('/api/orders',async(req,res)=>{
  try{
    const b=req.body||{}, customer=b.customer||{}, items=Array.isArray(b.items)?b.items:[];
    if(!clean(customer.name,100)||!clean(customer.phone,30)||!clean(customer.address,500)||!clean(customer.city,80)||!clean(customer.pincode,10))
      return res.status(400).json({error:'Name, phone, address, city and pincode are required'});
    if(customer.email && !validEmail(customer.email))return res.status(400).json({error:'Invalid email'});
    if(!items.length || items.length>30)return res.status(400).json({error:'Cart is empty or invalid'});
    const normalized=items.map(x=>({
      productId:clean(x.productId,60),
      quantity:Math.max(1,Math.min(100000,Number(x.quantity)||0))
    })).filter(x=>products.some(p=>p.id===x.productId));
    if(!normalized.length)return res.status(400).json({error:'No valid products in cart'});
    const total=totalFor(normalized);
    const order={
      id:makeId('PL'),
      customer:{
        name:clean(customer.name,100),email:clean(customer.email,150),
        phone:clean(customer.phone,30),address:clean(customer.address,500),
        city:clean(customer.city,80),state:clean(customer.state,80),
        pincode:clean(customer.pincode,10)
      },
      items:normalized,total,
      paymentMethod:clean(b.paymentMethod,30)||'COD',
      paymentStatus:clean(b.paymentStatus,30)||'pending',
      paymentId:clean(b.paymentId,100),
      status:'received',createdAt:new Date().toISOString()
    };
    await saveOrder(order);
    res.status(201).json({message:'Order placed',order});
  }catch(e){console.error(e);res.status(500).json({error:'Could not create order'})}
});

app.get('/api/orders/track/:id',async(req,res)=>{
  try{
    const o=await getOrder(req.params.id);
    if(!o)return res.status(404).json({error:'Order not found'});
    res.json({
      id:o.id,status:o.status,paymentStatus:o.payment_status||o.paymentStatus,
      total:Number(o.total),createdAt:o.created_at||o.createdAt,items:o.items
    });
  }catch(e){res.status(500).json({error:'Could not track order'})}
});

app.post('/api/quotes',async(req,res)=>{
  try{
    const b=req.body||{};
    if(!clean(b.name,100)||!clean(b.phone,30)||!clean(b.requirement,1000))
      return res.status(400).json({error:'Name, phone and requirement are required'});
    const qid=makeId('QT');
    await saveGeneric('quotes',qid,{payload:{
      name:clean(b.name,100),email:clean(b.email,150),phone:clean(b.phone,30),
      company:clean(b.company,150),quantity:clean(b.quantity,50),
      requirement:clean(b.requirement,1000)
    }});
    res.status(201).json({message:'Bulk quote request received',id:qid});
  }catch(e){console.error(e);res.status(500).json({error:'Could not submit quote'})}
});

app.post('/api/contact',async(req,res)=>{
  try{
    const b=req.body||{};
    if(!clean(b.name,100)||!validEmail(clean(b.email,150))||!clean(b.message,1500))
      return res.status(400).json({error:'Name, valid email and message are required'});
    const cid=makeId('CT');
    await saveGeneric('contacts',cid,{payload:{
      name:clean(b.name,100),email:clean(b.email,150),phone:clean(b.phone,30),message:clean(b.message,1500)
    }});
    res.status(201).json({message:'Message received',id:cid});
  }catch(e){console.error(e);res.status(500).json({error:'Could not submit message'})}
});

app.post('/api/payments/razorpay/order',async(req,res)=>{
  try{
    if(!razorpay)return res.status(503).json({error:'Online payment is not configured'});
    const amount=Math.round(Number(req.body.amount)*100);
    if(!amount||amount<100)return res.status(400).json({error:'Invalid amount'});
    const order=await razorpay.orders.create({amount,currency:'INR',receipt:makeId('RC')});
    res.json({id:order.id,amount:order.amount,currency:order.currency,keyId:process.env.RAZORPAY_KEY_ID});
  }catch(e){console.error(e);res.status(500).json({error:'Could not create payment order'})}
});

app.post('/api/payments/razorpay/verify',async(req,res)=>{
  try{
    if(!razorpay)return res.status(503).json({error:'Online payment is not configured'});
    const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body||{};
    const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if(expected!==razorpay_signature)return res.status(400).json({error:'Payment verification failed'});
    res.json({verified:true});
  }catch(e){res.status(500).json({error:'Could not verify payment'})}
});

app.get('/api/admin/orders',admin,async(req,res)=>{
  try{
    if(pool){
      const r=await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500');
      return res.json({orders:r.rows});
    }
    res.json({orders:readStore().orders.slice().reverse().slice(0,500)});
  }catch(e){res.status(500).json({error:'Could not load orders'})}
});

app.patch('/api/admin/orders/:id/status',admin,async(req,res)=>{
  const allowed=['received','confirmed','packed','shipped','delivered','cancelled'];
  if(!allowed.includes(req.body.status))return res.status(400).json({error:'Invalid status'});
  try{
    const o=await updateOrderStatus(req.params.id,req.body.status);
    if(!o)return res.status(404).json({error:'Order not found'});
    res.json({order:o});
  }catch(e){res.status(500).json({error:'Could not update order'})}
});

app.get(/.*/, (req,res)=>res.sendFile(path.join(__dirname,'index.html')));
initDb()
  .then(()=>app.listen(PORT,()=>console.log(`Paraslis running on http://localhost:${PORT}`)))
  .catch(e=>{console.error('DB init failed',e);process.exit(1)});


const state = { products: [], cart: JSON.parse(localStorage.getItem('paraslis_cart') || '[]') };

const $ = (s) => document.querySelector(s);
const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

function toast(message, ok=true){
  const el = $('#toast');
  el.textContent = message;
  el.style.borderLeftColor = ok ? 'var(--o)' : '#e33';
  el.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
function openModal(id){ document.getElementById(id)?.classList.add('open'); }
function closeModal(id){ document.getElementById(id)?.classList.remove('open'); }
window.closeModal = closeModal;

function saveCart(){ localStorage.setItem('paraslis_cart', JSON.stringify(state.cart)); updateCartCount(); }
function cartCount(){ return state.cart.reduce((s,x)=>s+x.quantity,0); }
function updateCartCount(){
  document.querySelectorAll('.nav-cta').forEach(b => b.textContent = `Cart (${cartCount()}) →`);
}
function addToCart(productId){
  const row = state.cart.find(x => x.productId === productId);
  if(row) row.quantity++;
  else state.cart.push({productId, quantity:1});
  saveCart(); renderCart(); toast('Added to cart.');
}
function changeQty(productId, delta){
  const row = state.cart.find(x=>x.productId===productId);
  if(!row) return;
  row.quantity += delta;
  if(row.quantity <= 0) state.cart = state.cart.filter(x=>x.productId!==productId);
  saveCart(); renderCart();
}
window.addToCart = addToCart;
window.changeQty = changeQty;

function renderCart(){
  const list = $('#cartList');
  if(!list) return;
  if(!state.cart.length){
    list.innerHTML = '<div style="padding:30px;text-align:center;color:var(--w2)">Your cart is empty.</div>';
    $('#cartTotal').textContent = money(0);
    $('#checkoutTotal').textContent = money(0);
    return;
  }
  let total=0;
  list.innerHTML = state.cart.map(row=>{
    const p=state.products.find(x=>x.id===row.productId);
    if(!p) return '';
    const line=p.price*row.quantity; total+=line;
    return `<div class="cart-row">
      <div><div class="cart-name">${p.name}</div><div class="cart-meta">${money(p.price)} / ${p.unit}</div></div>
      <div class="qty"><button onclick="changeQty('${p.id}',-1)">−</button><b>${row.quantity}</b><button onclick="changeQty('${p.id}',1)">+</button></div>
      <div class="cart-total">${money(line)}</div>
    </div>`;
  }).join('');
  $('#cartTotal').textContent = money(total);
  $('#checkoutTotal').textContent = money(total);
}

async function loadProducts(){
  const res=await fetch('/api/products');
  const data=await res.json();
  state.products=data.products||[];
  document.querySelectorAll('.pc').forEach((card,i)=>{
    const p=state.products[i];
    if(!p) return;
    const btn=card.querySelector('.cart-btn');
    if(btn){btn.setAttribute('onclick',`addToCart('${p.id}')`);btn.textContent='Add to Cart';}
  });
  renderCart(); updateCartCount();
}

window.openCheckout = function(){
  if(!state.cart.length){ toast('Your cart is empty.', false); return; }
  closeModal('cartModal'); renderCart(); openModal('checkoutModal');
};

document.addEventListener('DOMContentLoaded', async()=>{
  await loadProducts().catch(()=>toast('Could not load products.',false));

  document.querySelectorAll('.nav-cta').forEach(b=>b.onclick=()=>{renderCart();openModal('cartModal')});
  document.querySelectorAll('a[href="#"]').forEach(a=>a.addEventListener('click',e=>e.preventDefault()));

  document.querySelectorAll('.btn-p').forEach(btn=>{
    if(btn.textContent.includes('Order Now')) btn.onclick=()=>{renderCart();openModal('cartModal')};
  });
  document.querySelectorAll('.btn-s').forEach(btn=>{
    if(btn.textContent.includes('Get Bulk Quote')) btn.onclick=()=>openModal('quoteModal');
  });
  document.querySelectorAll('a').forEach(a=>{
    if(a.textContent.trim()==='Track Order') a.onclick=(e)=>{e.preventDefault();openModal('trackModal')};
  });

  const online = await fetch('/api/health').then(r=>r.json()).catch(()=>({}));
  if(online && online.razorpayConfigured){
    $('#onlinePayOption').style.display='block';
  }
});

$('#checkoutForm').addEventListener('submit', async(e)=>{
  e.preventDefault();
  if(!state.cart.length) return toast('Your cart is empty.',false);
  const form=new FormData(e.target);
  const customer=Object.fromEntries(form.entries());
  const paymentMethod=customer.paymentMethod; delete customer.paymentMethod;
  const total=state.cart.reduce((sum,row)=>{
    const p=state.products.find(x=>x.id===row.productId); return sum+(p?p.price*row.quantity:0);
  },0);

  async function createOrder(paymentStatus='pending', paymentId=''){
    const payload={customer,paymentMethod,items:state.cart,paymentStatus,paymentId};
    const res=await fetch('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const data=await res.json();
    if(!res.ok) throw new Error(data.error||'Could not place order');
    return data;
  }

  try{
    let data;
    if(paymentMethod==='RAZORPAY'){
      const payRes=await fetch('/api/payments/razorpay/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:total})});
      const payData=await payRes.json();
      if(!payRes.ok) throw new Error(payData.error||'Online payment is unavailable');
      if(!window.Razorpay){
        await new Promise((resolve,reject)=>{
          const s=document.createElement('script'); s.src='https://checkout.razorpay.com/v1/checkout.js';
          s.onload=resolve; s.onerror=()=>reject(new Error('Payment checkout could not load')); document.head.appendChild(s);
        });
      }
      data=await new Promise((resolve,reject)=>{
        const rzp=new Razorpay({
          key:payData.keyId,amount:payData.amount,currency:payData.currency,
          name:'Paraslis',description:'Biodegradable plates',order_id:payData.id,
          prefill:{name:customer.name,email:customer.email,contact:customer.phone},
          handler:async(resp)=>{
            try{
              const vr=await fetch('/api/payments/razorpay/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(resp)});
              const vd=await vr.json(); if(!vr.ok||!vd.verified) throw new Error(vd.error||'Payment verification failed');
              resolve(await createOrder('paid',resp.razorpay_payment_id));
            }catch(err){reject(err)}
          },
          modal:{ondismiss:()=>reject(new Error('Payment cancelled'))}
        });
        rzp.open();
      });
    }else{
      data=await createOrder('pending','');
    }
    state.cart=[]; saveCart(); e.target.reset(); closeModal('checkoutModal');
    toast(`Order placed successfully. ID: ${data.order.id}`);
    setTimeout(()=>{openModal('trackModal'); $('#trackForm input').value=data.order.id; trackOrder(data.order.id)},400);
  }catch(err){toast(err.message,false);}
});

async function trackOrder(orderId){
  try{
    const res=await fetch('/api/orders/track/'+encodeURIComponent(orderId));
    const data=await res.json();
    const box=$('#trackResult'); box.style.display='block';
    if(!res.ok){box.innerHTML=`<span style="color:#ff7777">${data.error||'Order not found'}</span>`;return;}
    box.innerHTML=`<div style="display:flex;justify-content:space-between;gap:10px;align-items:center">
      <div><b>${data.id}</b><div style="font-size:12px;color:var(--w2);margin-top:5px">${new Date(data.createdAt).toLocaleString('en-IN')}</div></div>
      <span class="status-pill">${data.status}</span>
    </div>
    <div style="margin-top:12px">Total: <b style="color:var(--o)">${money(data.total)}</b></div>`;
  }catch{toast('Could not track order.',false);}
}
$('#trackForm').addEventListener('submit',e=>{e.preventDefault();trackOrder(new FormData(e.target).get('id'))});

$('#quoteForm').addEventListener('submit',async(e)=>{
  e.preventDefault();
  const payload=Object.fromEntries(new FormData(e.target).entries());
  try{
    const res=await fetch('/api/quotes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const data=await res.json(); if(!res.ok) throw new Error(data.error||'Could not submit quote');
    e.target.reset(); closeModal('quoteModal'); toast(`Quote request received. Reference: ${data.id}`);
  }catch(err){toast(err.message,false);}
});

const express = require("express")
const cors = require("cors")
const http = require("http")
const WebSocket = require("ws")
const jwt = require("jsonwebtoken")
const admin = require("firebase-admin")

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY)

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
})

const app = express()

app.use(express.json())
app.use(cors())
app.use(express.static(__dirname))

const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

const SECRET = "gps_secret_key"

// ================= USERS =================
let users = [
{
id:1,
email:"test@test.pl",
password:"123456",
vehicles:[11]
}
]

// ================= FCM TOKENS =================
let fcmTokens = []

// ================= AUTH =================
function auth(req,res,next){

const header = req.headers["authorization"]

if(!header) return res.status(401).send("No token")

const token = header.split(" ")[1]

try{
const decoded = jwt.verify(token,SECRET)
req.user = decoded
next()
}catch(e){
res.status(403).send("Invalid token")
}

}

// ================= VEHICLES =================
const vehicles = [
{id:1,plate:"WA1234A"},
{id:2,plate:"WA5678B"},
{id:3,plate:"KR2233C"},
{id:4,plate:"GD8899D"},
{id:5,plate:"PO4455E"},
{id:6,plate:"LU7788F"},
{id:7,plate:"WR9988G"},
{id:8,plate:"BI4455H"},
{id:9,plate:"ZS6677I"},
{id:10,plate:"EL9988J"},
{id:11,plate:"WA1234C"},
]

// ================= ARM =================
const armedStatus = {};
vehicles.forEach(v => {
  armedStatus[v.id] = false;
});

app.post("/arm", (req, res) => {
  const { vehicle } = req.body;
  armedStatus[vehicle] = true;
  res.json({ status: "armed" });
});

app.post("/disarm", (req, res) => {
  const { vehicle } = req.body;
  armedStatus[vehicle] = false;
  res.json({ status: "disarmed" });
});

app.get("/armed/:id", (req, res) => {
  const id = Number(req.params.id);
  res.json({ armed: armedStatus[id] || false });
});

// ================= TOKEN REGISTER =================
app.post("/registerToken", (req,res)=>{

  const token = req.body.token

  if(token && !fcmTokens.includes(token)){
    fcmTokens.push(token)
    console.log("Nowy token:", token)
  }

  res.send("ok")
})

// ================= STORAGE =================
const locations = {}
const vehicleStatus = {}
const alarms = []

vehicles.forEach(v=>{
locations[v.id] = { lat:0, lon:0 }

vehicleStatus[v.id] = {
ignition:false,
power:12.5,
trackingFast:false,
history:[]
}
})

// ================= UTILS =================
function broadcast(payload){
const data = JSON.stringify(payload)

wss.clients.forEach(c=>{
if(c.readyState === WebSocket.OPEN){
c.send(data)
}
})
}

function addHistory(vehicle,event){

if(!vehicleStatus[vehicle]) return

vehicleStatus[vehicle].history.unshift({
event:event,
time:new Date().toLocaleTimeString()
})

if(vehicleStatus[vehicle].history.length > 60){
vehicleStatus[vehicle].history.pop()
}

broadcast({
type:"history_update",
vehicle:Number(vehicle)
})
}

function sendPush(title, body){

  fcmTokens.forEach(token => {

    admin.messaging().send({
      token: token,
      notification: {
        title: title,
        body: body
      }
    })
    .then(() => {
      console.log("Push sent")
    })
    .catch(err => {
      console.log("Push error:", err.message)
    })

  })

}

// ================= GPS =================
function handleGps(vehicle,lat,lon){

if(!vehicle || lat === undefined || lon === undefined){
return false
}

// zapis lokalizacji
locations[vehicle] = { lat:Number(lat), lon:Number(lon) }

let text = "GPS: " + Number(lat).toFixed(5) + " " + Number(lon).toFixed(5)

addHistory(vehicle,text)

// push do aplikacji
broadcast({
type:"gps_update",
vehicle:Number(vehicle),
lat:Number(lat),
lon:Number(lon)
})

return true
}

// ================= ALARM =================
function handleAlarm(vehicleId,alarmType,lat,lon){

if (!armedStatus[vehicleId]) {
  return null;
}

// jeśli przyszedł GPS → zapis
if(lat !== undefined && lon !== undefined){
locations[vehicleId] = {
lat:Number(lat),
lon:Number(lon)
}
}

let vehicle = vehicles.find(v=>v.id == vehicleId)

let alarm = {
id:Date.now(),
vehicle:vehicleId,
plate:vehicle ? vehicle.plate : "UNKNOWN",
type:alarmType,
lat:lat,
lon:lon,
time:new Date().toLocaleTimeString(),
status:"new"
}

alarms.unshift(alarm)

addHistory(vehicleId,"ALARM: " + alarmType)

broadcast({
type:"alarm_update",
alarm
})

sendPush(
  "🚨 ALARM " + alarmType,
  "Pojazd: " + (vehicle ? vehicle.plate : "UNKNOWN")
)

return alarm
}

// ================= WEBSOCKET =================
wss.on("connection",(ws)=>{

ws.on("message",(msg)=>{

try{
const data = JSON.parse(msg.toString())

if(data.type === "gps"){
handleGps(data.vehicle,data.lat,data.lon)
}

if(data.type === "alarm"){
handleAlarm(data.vehicle,data.type,data.lat,data.lon)
}

}catch(e){
console.log("WS error:",e.message)
}

})

})

// ================= API =================

// GPS
app.post("/gps",(req,res)=>{

const { vehicle, lat, lon } = req.body

const ok = handleGps(vehicle,lat,lon)

if(!ok){
return res.status(400).send("Missing GPS data")
}

res.send("ok")
})

// LOCATION
app.get("/location/:id",(req,res)=>{
const loc = locations[req.params.id]

if(!loc){
return res.json({lat:0,lon:0})
}

res.json(loc)
})

// ALARM
app.post("/alarm",(req,res)=>{

const { vehicle, type, lat, lon } = req.body

if(!vehicle || !type){
return res.status(400).send("Missing alarm data")
}

handleAlarm(vehicle,type,lat,lon)

if(lat !== undefined && lon !== undefined){
handleGps(vehicle,lat,lon)
}

res.send("ok")
})

app.get("/alarms",(req,res)=>{
res.json(alarms)
})

// USER ALARMS
app.get("/user/alarms",auth,(req,res)=>{

const user = users.find(u=>u.id === req.user.id)
if(!user) return res.json([])

const userVehicles = user.vehicles

const userAlarms = alarms.filter(a =>
userVehicles.includes(Number(a.vehicle))
)

res.json(userAlarms)
})

// VEHICLES
app.get("/vehicles",(req,res)=>{
res.json(vehicles)
})

app.get("/userVehicles",auth,(req,res)=>{

const user = users.find(u => u.id === req.user.id)
if(!user) return res.json([])

const userVehicles = vehicles.filter(v =>
user.vehicles.includes(v.id)
)

res.json(userVehicles)
})

// LOGIN
app.post("/login",(req,res)=>{

const {email,password} = req.body

const user = users.find(
u => u.email === email && u.password === password
)

if(!user){
return res.status(401).json({error:"Invalid login"})
}

const token = jwt.sign(
{id:user.id,email:user.email},
SECRET,
{expiresIn:"7d"}
)

res.json({token})

})

// START
server.listen(3000,"0.0.0.0",()=>{
console.log("Server running")
})
// Google Cloud Functions provider for AwardMan
//
// In order to run Functions on an end-user's account, they must:
//   1. Create a Google Cloud Platform account on https://console.cloud.google.com
//   2. Create a new project on https://console.cloud.google.com/projectcreate
//   3. Create a OAuth client id on: https://console.cloud.google.com/apis/credentials/oauthclient
//   4. Onto the OAuth client, add a javascript origin, for example: "http://localhost:8000"
//   5. Enable the Google Cloud Functions API on the project: https://console.developers.google.com/apis/library/cloudfunctions.googleapis.com
//
// For developers, example of div to show the login button:
//   <div id="googleSignIn" style="height: 20px"></div><div id="googleSignOut" style="height: 20px" hidden><button>Sign out</button></div>

/* global JSZip, SparkMD5, gapi */

export default class GCFProvider {
  constructor(config) {
    this.config = config
    // files (array): list of files (as strings) minus the path to upload, including index.js and package.json
    // filesDir (string): path relative to the main html file where the package to upload is
    // clientId (string): the oauth client_id to use for this project
    // projectId (string): the main project name the user should have already created
    // projectLocation (string): the gcf location name (ex. us-central1)
    // functionName (string): the function to create (or update)
    // authSignInDivId (string): the id of the div to put the google auth sign in button
    // authSignOutDivId (string): the id of the div to put the google auth sign out button

    this.location = `projects/${this.config.projectId}/locations/${this.config.projectLocation}`
    this.functionName = `${this.location}/functions/${this.config.functionName}`
    this.functionUrl = `https://${this.config.projectLocation}-${this.config.projectId}.cloudfunctions.net/${this.config.functionName}`
  }

  async initOnPage() {
    if (window.gInit || window.gapi)
      throw new Error("Cannot reload the GCF Provider!")

    // Called by GCP after platform.js loads
    window.gInit = () => {
      this.googleAuthInitEntry()
    }

    [
      {obj: "gapi", url: "https://apis.google.com/js/platform.js?onload=gInit"},
      {obj: "JSZip", url: "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.1.5/jszip.min.js"},
      {obj: "SparkMD5", url: "https://cdnjs.cloudflare.com/ajax/libs/spark-md5/3.0.0/spark-md5.min.js"}
    ].forEach(({obj, url}) => {
      if (!window[obj]) {
        const scriptTag = document.createElement("script")
        scriptTag.src = url
        document.head.appendChild(scriptTag)
      }
    })
  }

  googleAuthInitEntry() {
    gapi.load("client:auth2", async() => {
      /* eslint-disable camelcase */
      await gapi.client.init({
        discoveryDocs: ["https://cloudfunctions.googleapis.com/$discovery/rest?version=v1"],
        client_id: this.config.clientId,
        scope: "https://www.googleapis.com/auth/cloudfunctions https://www.googleapis.com/auth/cloud-platform"
      })
      await gapi.client.load({name: "cloudfunctions", version: "v1"})
      /* eslint-enable camelcase */

      gapi.signin2.render("googleSignIn", {
        theme: "dark",
        prompt: "select_account",
        onFailure: error => console.error(error),
        onSuccess: () => {
          console.log("GCF ready.")
          document.querySelector(`#${this.config.authSignInDivId}`).hidden = true
          document.querySelector(`#${this.config.authSignOutDivId}`).hidden = false
          document.querySelector(`#${this.config.authSignOutDivId} button`).onclick = () => {
            gapi.auth2.getAuthInstance().signOut().then(() => {
              document.querySelector(`#${this.config.authSignInDivId}`).hidden = false
              document.querySelector(`#${this.config.authSignOutDivId}`).hidden = true
            })
          }
        }
      })
    })
  }

  async waitForOperation(opName, attemptDelayMs, maxAttempts) {
    const delay = ms => new Promise(res => setTimeout(res, ms))

    for (let loopNo = 0; loopNo < maxAttempts; loopNo += 1) {
      /* eslint-disable no-await-in-loop */
      await delay(attemptDelayMs)

      const op = await gapi.client.cloudfunctions.operations.get({name: opName})
      if (op.result.done) {
        if (op.result.error)
          throw new Error(op.result.error.message)
        return op.result.response
      }
      /* eslint-enable no-await-in-loop */
    }
    throw new Error(`Timeout waiting for operation ${opName}`)
  }

  async prep() {
    if (!gapi.client.getToken())
      throw new Error("You must be logged in with your Google Account first!")

    console.log("Checking if GCP project exists...")
    try {
      await gapi.client.cloudfunctions.projects.locations.list({name: `projects/${this.config.projectId}`})
    } catch (err) {
      throw new Error(`Couldn't retrieve the GCP project '${this.config.projectId}'. Please review prerequisites for this script in gcf-provider.js.`)
    }

    console.log("Prepping package...")
    const zip = new JSZip()
    let roughHash = 0     // doing this because we want the same hash regardless of upload order
    await Promise.all(this.config.files.map(async file => {
      const scraperCode = await fetch(`${this.config.filesDir}/${file}`).then(result => result.text())
      zip.file(file, scraperCode)
      roughHash += parseInt(SparkMD5.hash(scraperCode).substr(0, 5), 16)
    }))
    const zipFile = await zip.generateAsync({type: "blob"})

    console.log("Getting if GCF has up to date scrapers...")
    let functionOnlyNeedsPatch = false
    try {
      const existingFunc = await gapi.client.cloudfunctions.projects.locations.functions.get({name: this.functionName})
      if (existingFunc.result.description === roughHash.toString(16)) {
        console.log("Scrapers are up to date!")
        return
      }
      functionOnlyNeedsPatch = true
    } catch (err) {
      if (err.status !== 404)
        throw err
    }

    console.log("Getting file upload url...")
    const uploadUrlResp = await gapi.client.cloudfunctions.projects.locations.functions.generateUploadUrl({parent: this.location})
    const {uploadUrl} = uploadUrlResp.result

    // WARNING: ABSOLUTELY NASTY HACK SINCE GOOGLE FUNCTIONS HAS A CORS BUG
    // see https://issuetracker.google.com/issues/114650724
    console.log("Uploading scrapers via CORS-Anywhere...")
    const noCorsUploadUrl = uploadUrl.replace("https://", "https://cors-anywhere.herokuapp.com/")
    await (await fetch(noCorsUploadUrl, {method: "PUT", headers: {"content-type": "application/zip", "x-goog-content-length-range": "0,104857600"}, body: zipFile})).text()

    console.log(`${functionOnlyNeedsPatch ? "Updating" : "Creating"} function...`)
    const funcParams = {
      name: this.functionName,
      description: roughHash.toString(16),
      sourceUploadUrl: uploadUrl,
      entryPoint: "gcfEntry",
      httpsTrigger: {},
      runtime: "nodejs8",
      timeout: "180s",
      availableMemoryMb: 2048
    }
    let operationResp = null
    if (functionOnlyNeedsPatch) {
      const updateMask = Object.keys(funcParams).join(",")
      operationResp = await gapi.client.cloudfunctions.projects.locations.functions.patch({name: this.functionName, updateMask, resource: funcParams})
    } else {
      operationResp = await gapi.client.cloudfunctions.projects.locations.functions.create({location: this.location, resource: funcParams})
    }
    const operationName = operationResp.result.name

    console.log("Waiting for function to be ready...")
    await this.waitForOperation(operationName, 5000, 12 * 5)    // 5 mins timeout

    console.log("Ready!")
  }

  async run(params) {
    console.log("Running function...")
    const respRaw = await fetch(this.functionUrl, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(params)})
    const out = await respRaw.json()

    console.log("Done!")

    return out
  }
}

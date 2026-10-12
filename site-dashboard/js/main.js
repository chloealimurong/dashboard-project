mapboxgl.accessToken = "pk.eyJ1IjoiY2hsb2VhbGltdXJvbmciLCJhIjoiY210dWR0cjcyMDBiNjM0cHFvN2p4b2RpMiJ9.EHtMZkiC7TklHIn836JPoQ";

var map = new mapboxgl.Map({
    container : "map",
    style: "mapbox://styles/chloealimurong/cmuyof1fv00l301rwe8m15eoy",
    zoom: 10.5,
    center: [-75.165222, 39.952583],
});

map.on("load", function(){
    const style = map.getStyle();
    style.layers.forEach((layer) => {
        if (layer.type === "symbol"){
            map.setLayoutProperty(layer.id, "visibility", "none");
        }
    });

    fetch("https://hub.arcgis.com/api/v3/datasets/e433504739bd41049de5d8f4a22d34ba_0/downloads/data?format=geojson&spatialRefId=4326&where=1%3D1")
        .then((res) => res.json);
})

window.map = map;

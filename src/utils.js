export const getTimeString = (time) => (`PT${Math.floor(time / 3600)}H${Math.floor(time / 60)}M${time % 60}S`)